import { EventSourceParserStream } from '../../apps/chatgpt-app/node_modules/eventsource-parser/dist/stream.js';

export async function* sseMessages(response: Response): AsyncGenerator<unknown> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Expected an SSE response');
  }
  const events = response.body.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onError: 'terminate', maxBufferSize: 1024 * 1024 }));
  for await (const event of events) yield JSON.parse(event.data);
}
