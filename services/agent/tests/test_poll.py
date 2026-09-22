import pytest

from agent.poll import poll_once

pytestmark = pytest.mark.unit


class FakeTelegram:
    def __init__(self, updates):
        self.updates = updates
        self.offsets = []

    async def get_updates(self, offset=None, wait=50):
        self.offsets.append(offset)
        return self.updates


class FakeHandler:
    def __init__(self):
        self.seen = []

    async def handle_update(self, update):
        self.seen.append(update["update_id"])


async def test_handles_each_update_and_advances_the_offset():
    tg, handler = FakeTelegram([{"update_id": 10}, {"update_id": 11}]), FakeHandler()
    assert await poll_once(tg, handler, offset=None) == 12
    assert handler.seen == [10, 11]
    assert tg.offsets == [None]


async def test_keeps_the_offset_when_nothing_arrives():
    assert await poll_once(FakeTelegram([]), FakeHandler(), offset=12) == 12
