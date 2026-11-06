export function sseParser() {
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      return frames.map((frame) => frame.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n'))
        .filter(Boolean);
    },
    get buffered() { return buffer.length; },
  };
}
