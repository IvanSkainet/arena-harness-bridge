const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once, on } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

for (const [fixture, description] of [
  ['fixture.html', 'sending, completion, PNG verification and draft protection'],
  ['batch.html', 'atomic ordered PNG uploads and upload rejection'],
  ['questions.html', 'native single-choice question controls and terminal widgets'],
  ['image-choices.html', 'native image choice previews and exact controls'],
  ['status-authority.html', 'standalone final tool frames after native status rows'],
  ['raw-reply.html', 'raw tool JSON preserved across a fragmented Markdown render'],
  ['review.html', 'native feedback and safe recovery before Send']
]) test('isolated Chrome exercises ' + description, async () => {
  const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bridge-fixture-'));
  const url = pathToFileURL(path.join(__dirname, fixture)).href;
  const proc = spawn(chrome, ['--headless=new','--disable-gpu','--no-first-run',
    '--disable-background-networking','--disable-sync','--allow-file-access-from-files',
    '--user-data-dir='+profile,'--remote-debugging-port=0',url],{stdio:'ignore',windowsHide:true});
  const exited = once(proc,'exit');
  let socket;
  try {
    const signal=AbortSignal.timeout(30000);
    const portFile=path.join(profile,'DevToolsActivePort');
    let target;
    while (!target) {
      await delay(50,undefined,{signal});
      assert.equal(proc.exitCode,null,'isolated Chrome exited before opening the fixture');
      if (!fs.existsSync(portFile)) continue;
      const port=fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0];
      const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list',{signal})).json();
      target=tabs.find(tab=>tab.type==='page' && tab.url===url);
    }
    socket=new WebSocket(target.webSocketDebuggerUrl);
    await once(socket,'open',{signal});
    const replies=on(socket,'message',{signal});
    try {
      for(let id=1;;id++) {
        socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{
          expression:"document.querySelector('#out')?.textContent",returnByValue:true
        }}));
        let answer;
        do { answer=JSON.parse((await replies.next()).value[0].data); } while(answer.id!==id);
        // Chrome can expose the target before the fixture's document has committed.
        if(answer.error && !/context/i.test(answer.error.message)) throw Error(answer.error.message);
        const status=answer.result?.result?.value;
        if(status && status!=='running' && !status.startsWith('Passed ')) {
          assert.equal(status,'All fixture checks passed');
          break;
        }
        await delay(80,undefined,{signal});
      }
    } finally { await replies.return(); }
  } finally {
    if (socket?.readyState===WebSocket.OPEN) {
      socket.send(JSON.stringify({id:2,method:'Browser.close'}));
      socket.close();
    } else proc.kill();
    await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
