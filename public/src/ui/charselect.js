// public/src/ui/charselect.js
// Character picker chips on the login overlay. The list comes from the
// AvatarFactory (recruit + every GLB the server's manifest lists).

export function buildCharSelect(container, list, currentId, onPick) {
  container.innerHTML = '';
  const buttons = new Map();
  for (const c of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip char' + (c.id === currentId ? ' on' : '');
    b.textContent = c.label;
    b.addEventListener('click', () => {
      for (const btn of buttons.values()) btn.classList.remove('on');
      b.classList.add('on');
      onPick(c.id);
    });
    buttons.set(c.id, b);
    container.appendChild(b);
  }
}
