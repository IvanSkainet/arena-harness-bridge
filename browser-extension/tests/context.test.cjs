const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('pending catalogue prepends to one trusted browser submit, including an explicit popup skill',async()=>{
  const chat='https://arena.ai/agent/one', context={id:'catalog-1',text:'Project catalogue'};
  const events=[], drafts=[], handlers={};
  const rows=[{role:'user',text:'past'},{role:'assistant',text:'past answer',complete:true}];
  const field={contains:()=>false}, button={contains:()=>false};
  let value='my task',listener,tick,upload=false;
  const target={addEventListener:(type,fn)=>{handlers[type]=fn;}};
  const ctx=vm.createContext({document:{...target,documentElement:{}},...target,location:{href:chat},crypto,URL,Date,
    MutationObserver:class{observe(){}},setInterval:fn=>{tick=fn;},setTimeout,clearTimeout,
    chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>{
      if(msg.event) events.push(msg.event); return {ok:true,job:null,context:null};
    }}},
    ArenaPage:class{
      rows(){return rows.slice();}
      state(){return {field,button,value,upload,idle:true,ready:!value && !upload};}
      browserAttachment(){throw Error('Multiple files or unsupported file type');}
      async submit(job,expected,check,click){assert.equal(expected,value);assert.ok(check());click();
        drafts.push(job.text);rows.push({role:'user',siteId:'user-'+drafts.length,text:job.text.replace(/\n+/g,'\n'),
          lastLine:job.text.split('\n').at(-1)},{role:'assistant',text:'final',complete:true});value='';}
    }
  });
  for(const file of ['core.js','content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  const control=msg=>new Promise(resolve=>listener(msg,{id:'test'},resolve));
  const prepared=await control({type:'prepare',chat});
  const address={chat,binding:'b1',pageKey:prepared.pageKey};
  await control({type:'attach',...address,context});
  assert.equal(typeof handlers.keydown,'function','trusted composer interception');
  let stops=0;
  const key={type:'keydown',key:'Enter',target:field,isTrusted:false,preventDefault(){stops++;},stopImmediatePropagation(){}};
  handlers.keydown(key);
  handlers.keydown({...key,isTrusted:true,shiftKey:true});
  assert.equal(stops,0);
  upload=true;
  for (const nativeText of ['', 'native attachments']) {
    value=nativeText;
    handlers.keydown({...key,isTrusted:true});
    handlers.click({...key,type:'click',button:0,target:button,isTrusted:true});
    assert.equal(stops,0,'leave native attachment submission with the browser');
    assert.equal(value,nativeText);
  }
  upload=false;value='my task';
  handlers.keydown({...key,isTrusted:true});
  await new Promise(resolve=>setImmediate(resolve));await tick();
  assert.match(drafts[0],/^Project catalogue\n\nmy task\n\nBridge delivery [a-f\d]{32}$/);
  assert.equal(events.filter(e=>e.kind==='user')[0].text,'Project catalogue\n\nmy task');
  assert.equal(events.filter(e=>e.kind==='user')[0].contextId,'catalog-1');
  assert.equal(stops,1);
  value='second';
  await control({type:'prepare',chat});
  await control({type:'attach',...address,context:{id:'catalog-2',text:'Changed catalogue'}});
  assert.equal((await control({type:'holdSkill',...address})).ok,true);
  await control({type:'applySkill',...address,name:'review',content:'Confirm input'});
  await control({type:'releaseSkill',...address});await tick();
  assert.match(drafts[1],/^Changed catalogue\n\nsecond\n\nLocal skill \(review\)\nConfirm input\n\nBridge delivery [a-f\d]{32}$/);
  assert.equal(events.filter(e=>e.kind==='user').at(-1).contextId,'catalog-2');
  value='ordinary follow-up';
  handlers.keydown({...key,isTrusted:true});
  await new Promise(resolve=>setImmediate(resolve));await tick();
  const receipt=/^ordinary follow-up\n\nBridge delivery ([a-f\d]{32})$/.exec(drafts[2]);
  assert.ok(receipt,'also stamp manual turns after the pending catalogue has been delivered');
  assert.equal(events.filter(e=>e.kind==='user').at(-1).id,receipt[1]);
});
