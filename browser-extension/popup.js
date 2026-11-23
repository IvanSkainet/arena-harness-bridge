'use strict';
const target = document.querySelector('#target');
const status = document.querySelector('#status');
async function rpc(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw Error(result?.error || 'Extension worker is unavailable.');
  return result;
}
async function run(message) {
  try {
    if (target.value !== '') message.tab = Number(target.value);
    status.textContent = (await rpc(message)).status;
    if (message.type === 'bind') document.querySelector('#token').value = '';
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#bind').addEventListener('submit', event => {
  event.preventDefault();
  run({ type: 'bind', token: document.querySelector('#token').value });
});
document.querySelector('#skill').addEventListener('submit', event => {
  event.preventDefault();
  run({ type: 'skill', name: document.querySelector('#name').value });
});
(async () => {
  try {
    const { targets } = await rpc({ type:'targets' });
    for (const item of targets) target.add(new Option(item.chat + ' (tab ' + item.tab + ')', String(item.tab)));
    const preset = new URLSearchParams(location.hash.slice(1)).get('tab');
    if (targets.some(item => String(item.tab) === preset)) target.value = preset;
    await run({ type:'status' });
  } catch (error) { status.textContent = error.message; }
})();
