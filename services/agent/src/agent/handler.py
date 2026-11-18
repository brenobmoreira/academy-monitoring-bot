"""Telegram update → bot → reply. Shared by the Cloud Run entry (main.py) and polling (poll.py)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime
from typing import Any, NamedTuple, Protocol, cast
from zoneinfo import ZoneInfo

import httpx

from agent import buttons, miniapp
from agent.bot import (
    MEDIA_DISABLED,
    MEDIA_UNREADABLE,  # noqa: F401 - re-exported for callers/tests
    MESSAGE_DEADLINE_AT,
    VOICE_BUDGET,
    VOICE_EMPTY,
    VOICE_FAILED,
    VOICE_FORMAT,
    VOICE_TOO_LONG,
    Answer,
    Bot,
    Media,
)
from agent.budget import Budget, MemoryBudget
from agent.commands import COMMANDS, CommandSheet, Context, Reply, parse_command
from agent.format import escape, split
from agent.llm import build_model
from agent.logs import describe
from agent.settings import Settings
from agent.sheet_client import SheetClient
from agent.telegram import TelegramClient
from agent.tools import update_key_scope
from agent.transcribe import Audio, TranscribeError, Transcript, build_transcriber
from agent.undo import undo_run
from agent.voice_confirm import (
    VOICE_CANCEL_OK,
    ClaimResult,
    TerminalOutcome,
    VoiceAction,
    VoiceConfirmations,
    sha256_hex,
    voice_toast,
)

log = logging.getLogger(__name__)

FAILURE = "⚠ Não consegui processar agora. Confira a planilha antes de reenviar."
TYPING_EVERY = 4.0  # seconds; Telegram clears the "typing…" status after about 5 s
MEDIA_MAX_BYTES = 5_000_000
VOICE_MAX_SECONDS = 90
# Seconds left after MESSAGE_DEADLINE_S to send the reply, then at most CUT_NOTICE_S to say an
# update was cut: with the default 90 s, an update ends within 115 s, below Cloud Run's 120 s.
SEND_RESERVE_S = 20.0
CUT_NOTICE_S = 5.0
CUT = (
    "⚠ Demorou demais e parei no meio: pode ter gravado ou desfeito algo. Confira com /hoje antes de repetir."
)
DOWNLOAD_FAILED = "⚠ Não consegui baixar o arquivo do Telegram. Tente de novo ou envie em texto."


class UpdateDeduplicator:
    """Thread-safe, in-process guard against duplicate Telegram update deliveries.

    While an update_id is in flight, a second delivery in the same instance is ignored immediately.
    Once an update reaches a terminal write outcome (`committed` or `uncertain`), is cut at the
    hard time limit, or sends a non-transient reply, its update_id is kept in a bounded FIFO cache
    so late webhook retries are ignored. Transient pre-write failures (sheet down before any write,
    download failure, or failed send with no write) release update_id so a retry can do the work.
    """

    def __init__(self, max_size: int = 1024) -> None:
        self._max_size = max_size
        self._lock = threading.Lock()
        self._in_flight: set[int] = set()
        self._completed: OrderedDict[int, None] = OrderedDict()

    def try_begin(self, update_id: int) -> bool:
        with self._lock:
            if update_id in self._in_flight or update_id in self._completed:
                return False
            self._in_flight.add(update_id)
            return True

    def finish(self, update_id: int, *, completed: bool) -> None:
        with self._lock:
            self._in_flight.discard(update_id)
            if completed:
                self._completed[update_id] = None
                self._completed.move_to_end(update_id)
                while len(self._completed) > self._max_size:
                    self._completed.popitem(last=False)


def too_large(max_bytes: int) -> str:
    size = f"{max_bytes / 1_000_000:.1f}".rstrip("0").rstrip(".").replace(".", ",")
    return f"O arquivo passa de {size} MB, o máximo que eu leio; envie em texto ou um arquivo menor."


class Replier(Protocol):
    async def reply(
        self,
        text: str,
        user_id: str = "telegram",
        *,
        context: str | None = None,
        media: list[Media] | None = None,
    ) -> Answer: ...


class VoiceTranscriber(Protocol):
    async def transcribe(
        self, audio: Audio, *, principal_key: str, deadline_s: float | None = None
    ) -> Transcript: ...


class Sender(Protocol):
    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        html: bool = False,
        reply_markup: dict[str, Any] | None = None,
        reply_to: int | None = None,
    ) -> dict[str, Any]: ...

    async def send_chat_action(self, chat_id: int, action: str = "typing") -> None: ...

    async def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> None: ...

    async def edit_message_reply_markup(
        self, chat_id: int, message_id: int, reply_markup: dict[str, Any] | None = None
    ) -> None: ...

    async def get_file(self, file_id: str) -> dict[str, Any]: ...

    async def download_file(self, file_path: str) -> bytes: ...


class MediaRef(NamedTuple):
    """The file of a voice, audio or photo message, before download."""

    file_id: str
    size: int | None  # as Telegram reports it; may be absent
    mime_type: str
    duration: int | None = None  # seconds from Telegram for voice/audio; None for photos or absent

    def fits(self, max_bytes: int) -> bool:
        return self.size is None or self.size <= max_bytes


class TooLarge(Exception):
    pass


def _audio_ref(message: dict[str, Any]) -> MediaRef | None:
    for key, default_mime in (("voice", "audio/ogg"), ("audio", "audio/mpeg")):
        item = message.get(key)
        if isinstance(item, dict) and isinstance(item.get("file_id"), str):
            mime = item.get("mime_type")
            return MediaRef(
                item["file_id"],
                _size(item),
                mime if isinstance(mime, str) and mime else default_mime,
                _duration(item),
            )
    return None


def media_ref(message: dict[str, Any], max_bytes: int) -> MediaRef | None:
    """The file to read from a voice, audio or photo message; None for any other message.

    Telegram sends each photo in several sizes (always JPEG): the largest that fits `max_bytes`
    is taken, or the smallest when none does (so the caller sees it is too large).
    """
    audio = _audio_ref(message)
    if audio is not None:
        return audio
    sizes = message.get("photo")
    photos = [
        MediaRef(p["file_id"], _size(p), "image/jpeg")
        for p in (sizes if isinstance(sizes, list) else [])
        if isinstance(p, dict) and isinstance(p.get("file_id"), str)
    ]
    if not photos:
        return None
    fitting = [p for p in photos if p.fits(max_bytes)]
    if fitting:
        return max(fitting, key=lambda p: p.size or 0)
    return min(photos, key=lambda p: p.size or 0)


def strict_int(raw: Any) -> int | None:
    """`raw` when it is an integer of an update (an id, a size), else None. JSON `true` is not one:
    Python counts a bool as an int, and `True` would pass for the id 1."""
    return raw if isinstance(raw, int) and not isinstance(raw, bool) else None


def _size(item: dict[str, Any]) -> int | None:
    return strict_int(item.get("file_size"))


def _duration(item: dict[str, Any]) -> int | None:
    seconds = strict_int(item.get("duration"))
    return seconds if seconds is not None and seconds >= 0 else None


def _message_fault(message: Any, where: str) -> str | None:
    if message is None:
        return None
    if not isinstance(message, dict):
        return where
    message_id = message.get("message_id")
    if message_id is not None and strict_int(message_id) is None:
        return f"{where}.message_id"
    chat = message.get("chat")
    if chat is None:
        return None
    if not isinstance(chat, dict):
        return f"{where}.chat"
    chat_id = chat.get("id")
    if chat_id is not None and strict_int(chat_id) is None:
        return f"{where}.chat.id"
    return None


def malformed_field(update: Any) -> str | None:
    """The first field of `update` whose type the handler cannot use, as a fixed name written here
    (never a value); None for an update it can process. Checked before any field is read: Telegram
    does not send these shapes, and resending one would not fix it. Absent fields are fine."""
    if not isinstance(update, dict):
        return "update"
    if "callback_query" in update:
        query = update["callback_query"]
        if not isinstance(query, dict):
            return "callback_query"
        return _message_fault(query.get("message"), "callback_query.message")
    return _message_fault(update.get("message"), "message")


class Handler:
    def __init__(
        self,
        allowed_chat_ids: frozenset[int] | set[int],
        bot: Replier,
        telegram: Sender,
        sheet: CommandSheet | None = None,
        timezone: str = "America/Sao_Paulo",
        clock: Callable[[], datetime] | None = None,
        typing_every: float = TYPING_EVERY,
        media_enabled: bool = True,
        media_max_bytes: int = MEDIA_MAX_BYTES,
        deduplicator: UpdateDeduplicator | None = None,
        message_deadline_s: float | None = None,
        send_reserve_s: float = SEND_RESERVE_S,
        miniapp_url: str = "",
        pending: miniapp.PendingStore | None = None,
        confirmations: VoiceConfirmations | None = None,
        transcriber: VoiceTranscriber | None = None,
        voice_max_seconds: int = VOICE_MAX_SECONDS,
    ) -> None:
        self._allowed = allowed_chat_ids
        self._bot = bot
        self._telegram = telegram
        self._sheet = sheet  # for the commands; the bot has its own reference
        zone = ZoneInfo(timezone)
        self._clock = clock or (lambda: datetime.now(zone))
        self._typing_every = typing_every
        self._media_enabled = media_enabled
        self._media_max_bytes = media_max_bytes
        self._deduplicator = deduplicator if deduplicator is not None else UpdateDeduplicator()
        self._message_deadline_s = message_deadline_s
        self._send_reserve_s = send_reserve_s
        self._miniapp_url = miniapp_url
        self._pending = pending if pending is not None else miniapp.PendingStore()
        self._confirmations = confirmations if confirmations is not None else VoiceConfirmations()
        self._transcriber = transcriber
        self._voice_max_seconds = voice_max_seconds

    async def handle_update(self, update: dict[str, Any]) -> None:
        """Never raises: a webhook that errors makes Telegram resend the same update. A malformed
        update is ignored: nothing is written or sent, and the log names the field, not its value."""
        fault = malformed_field(update)
        if fault is not None:
            raw_id = update.get("update_id") if isinstance(update, dict) else None
            log.warning("ignoring malformed Telegram update %s: bad %s", strict_int(raw_id), fault)
            return
        update_id = strict_int(update.get("update_id"))
        if update_id is not None and not self._deduplicator.try_begin(update_id):
            log.info("ignoring duplicate Telegram update %s", update_id)
            return
        completed = False
        # One budget from the arrival of the update: the media download and the agent share it,
        # and the reply goes out after it.
        token, hard_limit = None, None
        if self._message_deadline_s is not None:
            deadline_at = asyncio.get_running_loop().time() + self._message_deadline_s
            token = MESSAGE_DEADLINE_AT.set(deadline_at)
            # Commands, button taps and a reply sent in several parts stop here at the latest.
            hard_limit = deadline_at + self._send_reserve_s
        try:
            async with asyncio.timeout_at(hard_limit):
                completed = await self._process_update(update, update_id)
        except TimeoutError:
            log.warning("update %s cut at the message's hard time limit", update_id)
            completed = True
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(CUT_NOTICE_S):
                    await self._notify_cut(update)
        finally:
            if token is not None:
                MESSAGE_DEADLINE_AT.reset(token)
            if update_id is not None:
                self._deduplicator.finish(update_id, completed=completed)

    async def _notify_cut(self, update: dict[str, Any]) -> None:
        """Tells the person an update was cut and stops a button's spinner, both at once so a
        hanging one does not hold back the other; best effort."""
        query = update.get("callback_query")
        message = (query.get("message") if query else update.get("message")) or {}
        chat_id = (message.get("chat") or {}).get("id")
        if chat_id is None and isinstance(query, dict) and isinstance(query.get("from"), dict):
            chat_id = strict_int(query["from"].get("id"))
        update_id = strict_int(update.get("update_id"))

        async def answer(query: dict[str, Any]) -> None:
            try:
                await self._telegram.answer_callback_query(str(query.get("id", "")), CUT)
            except Exception as error:
                log.warning("could not answer the tap of update %s: %s", update_id, describe(error))

        async def tell(chat_id: int) -> None:
            try:
                await self._send(chat_id, Reply(CUT))
            except Exception as error:
                log.warning("could not tell the chat update %s was cut: %s", update_id, describe(error))

        notices = [answer(query)] if query else []
        if chat_id in self._allowed:
            notices.append(tell(chat_id))
        await asyncio.gather(*notices)

    async def _deliver(
        self,
        chat_id: int,
        reply: Reply,
        update_id: int | None,
        *,
        reply_to: int | None = None,
    ) -> bool:
        """Decides completion from `reply.write_outcome` (§4.3.4) before sending, then sends."""
        terminal = reply.write_outcome in ("committed", "uncertain")
        try:
            await self._send(chat_id, reply, reply_to=reply_to)
        except Exception as error:
            log.warning("could not send the reply of update %s: %s", update_id, describe(error))
            return terminal
        return terminal or not reply.transient

    async def _process_update(self, update: dict[str, Any], update_id: int | None) -> bool:
        if "callback_query" in update:
            return await self._callback(update["callback_query"], update_id)
        message = update.get("message") or {}
        text = message.get("text")
        chat_id = (message.get("chat") or {}).get("id")
        if chat_id not in self._allowed:
            return True
        form = message.get("web_app_data")
        # A `web_app_data` of another type counts as absent: the text of the message is not dropped.
        if isinstance(form, dict) and isinstance(form.get("data"), str):
            reply = await self._miniapp(form, chat_id, update_id)
        elif not isinstance(text, str) or not text.strip():
            return await self._media(message, chat_id, update_id)
        else:
            reply = await self._run_typed_text(text, message, chat_id, update_id)
        return await self._deliver(chat_id, reply, update_id)

    async def _run_typed_text(
        self, text: str, message: dict[str, Any], chat_id: int, update_id: int | None
    ) -> Reply:
        parsed = parse_command(text)
        if parsed is not None:
            return await self._command(*parsed, chat_id=chat_id, update_id=update_id)
        return await self._run_bot(text, message, update_id)

    async def _miniapp(self, web_app_data: Any, chat_id: int, update_id: int | None) -> Reply:
        """The form of the Mini App: validated and written without the model or any download."""
        raw = web_app_data.get("data") if isinstance(web_app_data, dict) else None
        try:
            if self._sheet is None:
                raise RuntimeError("this handler has no sheet API")
            sheet = cast(miniapp.MiniappSheet, self._sheet)
            return await miniapp.handle(
                sheet,
                raw if isinstance(raw, str) else "",
                chat_id,
                self._clock().date(),
                self._pending,
            )
        except Exception as error:
            log.warning("mini app data failed on update %s: %s", update_id, describe(error))
            return Reply(FAILURE, failed=True, transient=True)

    async def _run_bot(
        self,
        text: str,
        message: dict[str, Any],
        update_id: Any,
        media: list[Media] | None = None,
        *,
        scope_key: str | None = None,
        use_reply_context: bool = True,
    ) -> Reply:
        chat_id = message["chat"]["id"]
        typing = asyncio.create_task(self._keep_typing(chat_id, strict_int(update_id)))
        await asyncio.sleep(0)  # let the first action go out before the bot starts
        try:
            context = replied_text(message) if use_reply_context else None
            uid = strict_int(update_id)
            default_scope = f"tg:{uid}" if uid is not None else None
            resolved_scope = scope_key if scope_key is not None else default_scope
            with update_key_scope(resolved_scope):
                if media:
                    answer = await self._bot.reply(text, user_id=str(chat_id), context=context, media=media)
                else:
                    answer = await self._bot.reply(text, user_id=str(chat_id), context=context)
            markup = buttons.keyboard(answer.write_ids) if answer.wrote else None
            transient = answer.failed and answer.outcome not in ("committed", "uncertain")
            return Reply(
                answer.text,
                html=True,
                reply_markup=markup,
                failed=answer.failed,
                transient=transient,
                write_outcome=answer.outcome,
            )
        except Exception as error:
            log.warning("bot failed on update %s: %s", update_id, describe(error))
            return Reply(FAILURE, failed=True, transient=True)
        finally:
            typing.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await typing

    async def _media(self, message: dict[str, Any], chat_id: int, update_id: int | None) -> bool:
        """Voice, audio and photo messages (caption optional); ignored for anything else (stickers,
        documents, service messages), which gets no reply."""
        audio_ref = _audio_ref(message)
        is_audio = audio_ref is not None
        ref = audio_ref if is_audio else media_ref(message, self._media_max_bytes)
        if ref is None:
            return True
        raw_caption = message.get("caption")
        caption = raw_caption if isinstance(raw_caption, str) else ""
        if not self._media_enabled:
            reply = await self._disabled_media(caption, message, chat_id, update_id)
            return await self._deliver(chat_id, reply, update_id)
        if is_audio and ref.duration is not None and ref.duration > self._voice_max_seconds:
            return await self._deliver(chat_id, Reply(VOICE_TOO_LONG), update_id)
        if not ref.fits(self._media_max_bytes):
            return await self._deliver(chat_id, Reply(too_large(self._media_max_bytes)), update_id)
        try:
            deadline_at = MESSAGE_DEADLINE_AT.get()
            async with asyncio.timeout_at(deadline_at):
                data = await self._download(ref)
        except TooLarge:
            return await self._deliver(chat_id, Reply(too_large(self._media_max_bytes)), update_id)
        except Exception as error:
            log.warning("could not download the file of update %s: %s", update_id, describe(error))
            return await self._deliver(
                chat_id, Reply(DOWNLOAD_FAILED, failed=True, transient=True), update_id
            )
        if not is_audio:
            reply = await self._run_bot(caption, message, update_id, media=[Media(ref.mime_type, data)])
            return await self._deliver(chat_id, reply, update_id)
        return await self._voice_message(ref, data, caption, message, chat_id, update_id)

    async def _disabled_media(
        self, caption: str, message: dict[str, Any], chat_id: int, update_id: int | None
    ) -> Reply:
        if not caption.strip():
            return Reply(MEDIA_DISABLED)
        reply = await self._run_typed_text(caption, message, chat_id, update_id)
        notice = escape(MEDIA_DISABLED) if reply.html else MEDIA_DISABLED
        combined = f"{reply.text}\n\n{notice}" if reply.text else notice
        return replace(reply, text=combined)

    async def _voice_message(
        self,
        ref: MediaRef,
        data: bytes,
        caption: str,
        message: dict[str, Any],
        chat_id: int,
        update_id: int | None,
    ) -> bool:
        """Transcribes `data` and sends the plain-text `🎙️ Entendi:` confirmation (§4.1)."""
        result = await self._transcribe_audio(ref, data, chat_id, update_id)
        if isinstance(result, Reply):
            return await self._deliver(chat_id, result, update_id)
        clean_caption = caption.strip()
        body = f"{clean_caption}\n{result.text}" if clean_caption else result.text
        vid = self._confirmations.create(chat_id, sha256_hex(body))
        try:
            sent = await self._telegram.send_message(
                chat_id,
                buttons.entendi_text(body),
                html=False,
                reply_markup=buttons.voice_keyboard(vid),
                reply_to=strict_int(message.get("message_id")),
            )
        except Exception as error:
            self._confirmations.discard(vid)
            log.warning("could not send the reply of update %s: %s", update_id, describe(error))
            return False
        except BaseException:
            self._confirmations.discard(vid)
            raise
        sent_mid = strict_int(sent.get("message_id")) if isinstance(sent, dict) else None
        if sent_mid is not None:
            self._confirmations.set_message_id(vid, sent_mid)
        return True

    async def _transcribe_audio(
        self, ref: MediaRef, data: bytes, chat_id: int, update_id: int | None
    ) -> Transcript | Reply:
        if self._transcriber is None:
            return _voice_error_reply("disabled")
        typing = asyncio.create_task(self._keep_typing(chat_id, strict_int(update_id)))
        await asyncio.sleep(0)
        try:
            # MESSAGE_DEADLINE_AT already stops before SEND_RESERVE_S (hard_limit = deadline_at + reserve).
            deadline_at = MESSAGE_DEADLINE_AT.get()
            deadline_s = None if deadline_at is None else deadline_at - asyncio.get_running_loop().time()
            return await self._transcriber.transcribe(
                Audio(ref.mime_type, data, trusted_seconds=ref.duration),
                principal_key=f"telegram:{chat_id}",
                deadline_s=deadline_s,
            )
        except TranscribeError as error:
            log.warning("voice transcription failed on update %s: %s", update_id, describe(error))
            return _voice_error_reply(error.code)
        except Exception as error:
            log.warning("voice transcription failed on update %s: %s", update_id, describe(error))
            return Reply(VOICE_FAILED, failed=True, transient=True)
        finally:
            typing.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await typing

    async def _download(self, ref: MediaRef) -> bytes:
        file = await self._telegram.get_file(ref.file_id)
        size = strict_int(file.get("file_size"))
        if size is not None and size > self._media_max_bytes:
            raise TooLarge
        path = file.get("file_path")
        if not isinstance(path, str) or not path:
            raise ValueError("getFile returned no file_path")
        data = await self._telegram.download_file(path)
        if len(data) > self._media_max_bytes:
            raise TooLarge
        return data

    async def _command(self, name: str, args: str, chat_id: int, update_id: int | None = None) -> Reply:
        """Registered commands answer from the sheet alone; they never reach the model. Their
        arguments are typed text and the sheet can repeat them in an error, so a failure is logged
        through describe() (`name` is a key of COMMANDS)."""
        ctx = Context(
            sheet=self._sheet,
            today=self._clock().date(),
            chat_id=chat_id,
            miniapp_url=self._miniapp_url,
        )
        try:
            return await COMMANDS[name].run(ctx, args)
        except Exception as error:
            log.error("command /%s failed on update %s: %s", name, update_id, describe(error))
            return Reply(FAILURE, failed=True, transient=True)

    async def _answer_callback(self, query: dict[str, Any], toast: str | None, update_id: int | None) -> None:
        try:
            await self._telegram.answer_callback_query(str(query.get("id", "")), toast)
        except Exception as error:
            log.error("could not answer the tap of update %s: %s", update_id, describe(error))

    async def _callback(self, query: dict[str, Any], update_id: int | None = None) -> bool:
        """A tap on an inline button. Always answered (Telegram shows a spinner until then), even
        when the chat is not allowed or the action fails; the failure shows as a toast. A tap can
        replay what the person sent (🔁 runs a stored form), so a failure is logged through
        describe(), with the button's action and never its `callback_data`."""
        raw_message = query.get("message")
        message = raw_message if isinstance(raw_message, dict) else {}
        if isinstance(raw_message, dict) and raw_message.get("chat") is not None:
            chat_id = (raw_message.get("chat") or {}).get("id")
        else:
            sender = query.get("from")
            chat_id = strict_int(sender.get("id")) if isinstance(sender, dict) else None
        message_id = strict_int(message.get("message_id"))
        data = str(query.get("data") or "")
        verb, _ = buttons.parse(data)
        if verb in buttons.VOICE_VERBS:
            if chat_id not in self._allowed:
                await self._answer_callback(query, None, update_id)
                return True
            return await self._voice_button(
                cast(VoiceAction, verb),
                data.partition(":")[2],
                query,
                raw_message,
                chat_id,
                message_id,
                update_id,
            )
        toast = None
        completed = True
        try:
            if chat_id in self._allowed and message_id is not None:
                completed = await self._button(data, chat_id, message_id, message, update_id)
        except Exception as error:
            log.error("button %s failed on update %s: %s", buttons.action(data), update_id, describe(error))
            toast = FAILURE
            completed = False
        await self._answer_callback(query, toast, update_id)
        return completed

    async def _voice_button(
        self,
        verb: VoiceAction,
        vid: str,
        query: dict[str, Any],
        raw_message: Any,
        chat_id: int,
        message_id: int | None,
        update_id: int | None,
    ) -> bool:
        """Handles `vok:<vid>`, `vfix:<vid>` and `vno:<vid>` (§4.1), answering the callback first."""
        claim = self._confirmations.claim(vid, chat_id, verb)
        transcript: str | None = None
        if claim.ok and verb in (buttons.VOICE_OK, buttons.VOICE_FIX):
            expected = claim.entry.text_sha256 if claim.entry is not None else ""
            transcript = buttons.transcript_from(raw_message, expected)
            if transcript is None:
                self._confirmations.expire(vid)
                claim = ClaimResult(ok=False, state="expired", refusal="expired", entry=claim.entry)

        await self._answer_callback(query, voice_toast(verb, claim), update_id)

        target_mid = (
            message_id
            if message_id is not None
            else (claim.entry.message_id if claim.entry is not None else None)
        )
        if not claim.ok:
            if (claim.refusal in ("unknown", "expired") or claim.state == "expired") and (
                target_mid is not None and claim.refusal != "wrong_chat"
            ):
                await self._remove_keyboard(chat_id, target_mid)
            return True

        if verb == buttons.VOICE_NO:
            if target_mid is not None:
                await self._remove_keyboard(chat_id, target_mid)
            return await self._deliver(chat_id, Reply(VOICE_CANCEL_OK), update_id, reply_to=target_mid)

        assert transcript is not None
        if verb == buttons.VOICE_FIX:
            text, markup = buttons.voice_fix_prompt(transcript)
            return await self._deliver(
                chat_id,
                Reply(text, html=True, reply_markup=markup),
                update_id,
                reply_to=target_mid,
            )

        if target_mid is not None:
            await self._remove_keyboard(chat_id, target_mid)
        try:
            reply = await self._run_bot(
                transcript,
                {"chat": {"id": chat_id}},
                update_id,
                scope_key=f"tg:voice:{vid}",
                use_reply_context=False,
            )
        except BaseException:
            self._confirmations.finish(vid, "uncertain")
            raise
        deadline_at = MESSAGE_DEADLINE_AT.get()
        cut = deadline_at is not None and asyncio.get_running_loop().time() >= deadline_at and reply.failed
        outcome: TerminalOutcome = "uncertain" if (reply.write_outcome == "uncertain" or cut) else "done"
        self._confirmations.finish(vid, outcome)
        delivered = await self._deliver(chat_id, reply, update_id, reply_to=target_mid)
        return delivered or outcome == "uncertain"

    async def _button(
        self,
        data: str,
        chat_id: int,
        message_id: int,
        message: dict[str, Any],
        update_id: int | None = None,
    ) -> bool:
        verb, ids = buttons.parse(data)
        if verb == buttons.OK:
            await self._remove_keyboard(chat_id, message_id)
            return True
        if verb == buttons.UNDO:
            if self._sheet is None:
                raise RuntimeError("this handler has no sheet API")
            run = await undo_run(self._sheet, ids)
            if not run.sheet_down:  # otherwise keep the button for another try
                await self._remove_keyboard(chat_id, message_id)
            reply = Reply(run.text, transient=run.sheet_down, write_outcome=run.outcome)
            return await self._deliver(chat_id, reply, update_id, reply_to=message_id)
        if verb == buttons.RETRY:
            if self._sheet is None:
                raise RuntimeError("this handler has no sheet API")
            sheet = cast(miniapp.MiniappSheet, self._sheet)
            reply = await miniapp.retry(sheet, ids[0] if ids else "", self._pending, chat_id)
            if reply.write_outcome in ("committed", "uncertain") or not reply.transient:
                await self._remove_keyboard(chat_id, message_id)
            return await self._deliver(chat_id, reply, update_id, reply_to=message_id)
        if verb == buttons.FIX:
            text, markup = buttons.fix_prompt(message.get("text"))
            return await self._deliver(
                chat_id, Reply(text, reply_markup=markup), update_id, reply_to=message_id
            )
        log.warning("unknown button data of %d characters on update %s", len(data), update_id)
        return True

    async def _remove_keyboard(self, chat_id: int, message_id: int) -> None:
        """Cosmetic: a message already edited (double tap) or too old to edit keeps its buttons."""
        try:
            await self._telegram.edit_message_reply_markup(chat_id, message_id)
        except Exception as error:
            log.warning("could not remove the buttons of message %s: %s", message_id, describe(error))

    async def _keep_typing(self, chat_id: int, update_id: int | None = None) -> None:
        """Shows "typing…" until cancelled. Cosmetic: the first failure stops it, the reply is unaffected."""
        while True:
            try:
                await self._telegram.send_chat_action(chat_id)
            except Exception as error:
                log.warning("could not send the typing action for update %s: %s", update_id, describe(error))
                return
            await asyncio.sleep(self._typing_every)

    async def _send(self, chat_id: int, reply: Reply, reply_to: int | None = None) -> None:
        """Sends the reply as Telegram HTML (plain text is escaped first) in as many messages as it
        needs; only the last one gets the markup, only the first quotes `reply_to`."""
        chunks = split(reply.text if reply.html else escape(reply.text))
        for i, chunk in enumerate(chunks):
            markup = reply.reply_markup if i == len(chunks) - 1 else None
            quote = reply_to if i == 0 else None
            await self._telegram.send_message(chat_id, chunk, html=True, reply_markup=markup, reply_to=quote)


def _voice_error_reply(code: str) -> Reply:
    if code == "disabled":
        return Reply(MEDIA_DISABLED)
    if code == "unsupported_format":
        return Reply(VOICE_FORMAT)
    if code == "too_long":
        return Reply(VOICE_TOO_LONG)
    if code == "no_speech":
        return Reply(VOICE_EMPTY)
    if code == "budget_exhausted":
        return Reply(VOICE_BUDGET)
    return Reply(VOICE_FAILED, failed=True, transient=True)


def replied_text(message: dict[str, Any]) -> str | None:
    """The text of the bot message this one replies to (swipe-reply or ✏️ Corrigir), the only
    context the agent gets from earlier messages besides the sheet's recent writes. A reply to
    the user's own message, to the voice fix prompt (§4.1), or to one without text gives none."""
    replied = message.get("reply_to_message")
    author = replied.get("from") if isinstance(replied, dict) else None
    # `is True`: a string ("false") or a number in `is_bot` does not make the author a bot.
    if not isinstance(replied, dict) or not isinstance(author, dict) or author.get("is_bot") is not True:
        return None
    text = replied.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    if text.splitlines()[0].strip() == buttons.VOICE_FIX_PROMPT:
        return None
    return text


def build_handler(
    settings: Settings,
    http: httpx.AsyncClient,
    *,
    deduplicator: UpdateDeduplicator | None = None,
    confirmations: VoiceConfirmations | None = None,
    budget: Budget | None = None,
    transcriber: VoiceTranscriber | None = None,
) -> Handler:
    sheet = SheetClient(settings.SHEET_API_URL, settings.SHEET_API_KEY.get_secret_value(), http)
    bot = Bot(
        sheet,
        build_model(settings),
        timezone=settings.TIMEZONE,
        max_llm_calls=settings.MAX_LLM_CALLS,
        deadline_s=settings.MESSAGE_DEADLINE_S,
    )
    telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
    resolved_transcriber = transcriber
    if resolved_transcriber is None and settings.MEDIA_ENABLED:
        resolved_budget = (
            budget
            if budget is not None
            else MemoryBudget(
                principal_daily=settings.VOICE_DAILY_TOKENS,
                global_daily=settings.VOICE_GLOBAL_DAILY_TOKENS,
                timezone=settings.TIMEZONE,
            )
        )
        resolved_transcriber = build_transcriber(settings, resolved_budget)
    return Handler(
        settings.ALLOWED_CHAT_IDS,
        bot,
        telegram,
        sheet=sheet,
        timezone=settings.TIMEZONE,
        media_enabled=settings.MEDIA_ENABLED,
        media_max_bytes=settings.MEDIA_MAX_BYTES,
        message_deadline_s=settings.MESSAGE_DEADLINE_S,
        deduplicator=deduplicator,
        miniapp_url=settings.MINIAPP_URL,
        confirmations=confirmations,
        transcriber=resolved_transcriber,
        voice_max_seconds=settings.VOICE_MAX_SECONDS,
    )
