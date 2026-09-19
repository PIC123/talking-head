import type { Logger } from '../agent/session';

/** Error/transcript panel, visible only in edit mode. Errors never reach the projection. */
export function createLog(el: HTMLElement, max = 80): Logger {
  return (kind, text) => {
    const line = document.createElement('div');
    line.className = kind;
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    line.textContent = `${ts} ${kind === 'agent' ? 'AI> ' : kind === 'user' ? 'you> ' : ''}${text}`;
    el.appendChild(line);
    while (el.childElementCount > max) el.firstElementChild?.remove();
    el.scrollTop = el.scrollHeight;
    if (kind === 'err') console.error(text);
    else console.log(text);
  };
}
