(() => {
  const script = document.currentScript;
  const source = new URL(script.src);
  const id = source.searchParams.get('widget');
  if (!id || !/^[\w-]+$/.test(id)) return;
  const destination = new URL('/widgets/' + id + '/popup', source.origin);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Zarezerwuj rower';
  button.addEventListener('click', () => {
    const popup = window.open('', '_blank', 'popup,width=760,height=860');
    if (!popup) {
      window.location.assign(destination.href);
      return;
    }
    popup.opener = null;
    popup.location.replace(destination.href);
  });
  if (script.closest('body')) script.after(button);
  else document.body.append(button);
})();
