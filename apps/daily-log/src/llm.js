/**
 * Minimal client for any OpenAI-compatible chat-completions endpoint (Gemini's compatibility
 * layer, a LiteLLM proxy, OpenAI itself). Provider is configuration, never code.
 */
const LlmClient = {
  /**
   * @param {{system: string, user: string, schemaName: string, schema: Object}} request
   * @returns {Object} the parsed JSON object the model produced
   */
  extract(request) {
    const cfg = Config.llm();
    if (!cfg) throw new Error('LLM not configured');
    const body = {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: request.schemaName, strict: true, schema: request.schema },
      },
    };
    const response = UrlFetchApp.fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code !== 200) throw new Error(`LLM HTTP ${code}: ${text.slice(0, 300)}`);
    const content = LlmClient.content_(JSON.parse(text));
    try {
      return JSON.parse(LlmClient.stripFences_(content));
    } catch (err) {
      throw new Error(`LLM returned non-JSON: ${String(content).slice(0, 300)}`);
    }
  },

  content_(payload) {
    const choice = payload.choices && payload.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (typeof content !== 'string') throw new Error('LLM response has no message content');
    return content;
  },

  stripFences_(s) {
    return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  },
};
