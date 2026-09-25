// Online chat box: Enter opens it, Enter sends, Esc closes. Lines fade after a while unless the box
// is open. Text is always inserted with textContent, never as HTML.
import { CHAT_MAX } from '/contracts/protocol.js';
import { TEAM_CSS } from './render/models.js';

const FADE_MS = 10000;
const KEEP = 50; // lines kept in the log

export class Chat {
  // `send(text)` delivers a line to the server.
  constructor(root, send) {
    this.root = root;
    this.send = send;
    this.log = root.querySelector('.chat-log');
    this.input = root.querySelector('input');
    this.input.maxLength = CHAT_MAX;
    this.names = ['', ''];
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing never reaches the game's own key handlers
      if (e.key === 'Enter') {
        const text = this.input.value.trim();
        if (text) this.send(text);
        this.close();
      } else if (e.key === 'Escape') this.close();
    });
    this.input.addEventListener('blur', () => this.close());
  }

  get enabled() { return !this.root.classList.contains('hidden'); }
  get typing() { return document.activeElement === this.input; }

  // Shown for online matches only. `names` = display name per slot.
  show(names) {
    this.names = names;
    this.root.classList.remove('hidden');
  }

  hide() {
    this.close();
    this.root.classList.add('hidden');
    this.log.replaceChildren();
  }

  open() {
    if (!this.enabled) return;
    this.root.classList.add('open');
    this.input.focus();
  }

  close() {
    this.input.value = '';
    this.root.classList.remove('open');
    if (this.typing) this.input.blur();
  }

  add(from, text) {
    const line = document.createElement('div');
    line.className = 'chat-line';
    const who = document.createElement('b');
    who.textContent = `${this.names[from] || 'Player'}: `;
    who.style.color = TEAM_CSS[from] || '';
    line.append(who, document.createTextNode(text));
    this.log.append(line);
    while (this.log.children.length > KEEP) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
    setTimeout(() => line.classList.add('faded'), FADE_MS);
  }
}
