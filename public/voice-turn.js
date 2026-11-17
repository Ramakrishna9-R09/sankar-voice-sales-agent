// Keep interruption side effects in one synchronous operation. The VAD callback can
// safely invalidate stale SSE/TTS callbacks before the next browser task runs.
export function cancelVoiceGeneration(state, rerender = () => {}) {
  if (!state?.speaking && !state?.thinking) return false;
  state.speechGeneration += 1;
  state.speechQueue = [];
  state.autoEndCall = false;
  state.turnController?.abort();
  state.turnController = null;
  state.speechController?.abort();
  state.speechController = null;
  state.thinking = false;
  state.speaking = false;
  if (state.streamMessage) {
    state.messages = state.messages.filter((message) => message !== state.streamMessage);
    state.streamMessage = null;
    rerender();
  }
  if (state.audioElement) {
    state.audioElement.pause();
    state.audioElement.removeAttribute('src');
  }
  return true;
}
