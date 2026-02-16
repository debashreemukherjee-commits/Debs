export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAICallOptions {
  messages: OpenAIMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface OpenAIResponse {
  content: string;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export async function callOpenAI(
  apiKey: string,
  options: OpenAICallOptions
): Promise<OpenAIResponse> {
  const {
    messages,
    model = 'gpt-4o-mini',
    temperature = 0.7,
    maxTokens = 1000,
    responseFormat = 'text',
    topP,
    frequencyPenalty,
    presencePenalty,
  } = options;

  if (!apiKey) {
    throw new Error('OpenAI API key is required');
  }

  if (!messages || messages.length === 0) {
    throw new Error('At least one message is required');
  }

  const requestBody: any = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  if (responseFormat === 'json_object') {
    requestBody.response_format = { type: 'json_object' };
  }

  if (topP !== undefined) {
    requestBody.top_p = topP;
  }

  if (frequencyPenalty !== undefined) {
    requestBody.frequency_penalty = frequencyPenalty;
  }

  if (presencePenalty !== undefined) {
    requestBody.presence_penalty = presencePenalty;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenAI API Error Status:', response.status);
    console.error('OpenAI API Error Details:', errorText);

    try {
      const errorJson = JSON.parse(errorText);
      console.error('OpenAI Error Code:', errorJson.error?.code);
      console.error('OpenAI Error Message:', errorJson.error?.message);
      console.error('OpenAI Error Type:', errorJson.error?.type);
      throw new Error(
        `OpenAI API error: ${response.status} - ${errorJson.error?.message || errorText}`
      );
    } catch (e) {
      throw new Error(`OpenAI API error: ${response.status} - ${errorText.substring(0, 200)}`);
    }
  }

  const data = await response.json();
  const choice = data.choices[0];

  return {
    content: choice.message.content,
    finishReason: choice.finish_reason,
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
  };
}

export function parseJSONResponse<T = any>(content: string): T {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error.message}`);
  }
}
