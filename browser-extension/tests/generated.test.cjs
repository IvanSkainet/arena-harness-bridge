const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

for (const mode of ['explicit finish','summary','same native reply','literal before images','images only',
  'late final at publication','late prose inside the image row','late prose still streaming',
  'incomplete result','unfinished shell','repeated source','replaced before publication','replaced while extending']) {
test('a single Arena image batch handles '+mode,async()=>{
  const chat='https://arena.ai/agent/example', events=[];
  const rows=[{role:'user',text:'Previous task'},{role:'assistant',text:'Previous reply',complete:true}];
  let listen,tick,notify,now=10000,generating=false;
  const ctx=vm.createContext({crypto,URL,location:{href:chat},Date:class extends Date{static now(){return now;}},
    document:{documentElement:{}},addEventListener(){},MutationObserver:class{constructor(fn){notify=fn;}observe(){}},
    setInterval:fn=>{tick=fn;},ArenaGeneratedImages:{activate(){},encode:async artifact=>
      artifact.sources.map(data=>({mediaType:'image/png',data}))},
    ArenaPage:class{rows(){return rows.map(row=>({...row}));}
      state(){return {generating,idle:!generating,ready:false,field:{},value:'separate unsent draft'};}},
    chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listen=fn},sendMessage:async msg=>{
      if(msg.event) events.push(msg.event);
      return {ok:true,job:null};
    }}}
  });
  for(const file of ['core.js','content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  const control=msg=>new Promise(resolve=>listen(msg,{id:'test'},resolve));
  const prep=await control({type:'prepare',chat});
  assert.equal((await control({type:'attach',chat,pageKey:prep.pageKey,binding:'b1'})).ok,true);
  const prompt=mode==='same native reply'
    ? 'Сгенерируй 10 отдельных изображений. После последнего изображения напиши, что получилось.'
    : mode==='summary' ? 'Generate ten separate images. After the images, summarize what you made.'
    : 'Generate 10 separate images, then say Done.';
  rows.push({role:'user',text:prompt});
  const add = (id,text,artifact) => rows.push({role:'assistant',text,complete:true,nativeMessage:true,
    siteId:'chat-message-'+id,artifact,artifactsPending:!!artifact});
  const step=async (advance=0)=>{
    now+=advance;notify();await new Promise(resolve=>setImmediate(resolve));await tick();
  };
  const count=['explicit finish','summary','replaced before publication','replaced while extending'].includes(mode) ? 10 : 5;
  if (mode==='images only' || mode.startsWith('late ')) {
    const sources=Array.from({length:10},(_,i)=>'no-caption-'+(i+1));
    add('all-images','',{images:sources.map(()=>({})),sources});
    await step();
    now+=13000;notify();
    await new Promise(resolve=>setImmediate(resolve));
    const trailing=mode==='images only' ? '' : 'Here are the ten cards.';
    if (mode==='late prose inside the image row') {
      rows.at(-1).text=rows.at(-1).postImageProse=trailing;
    } else if (mode==='late prose still streaming') {
      rows.push({role:'unknown',text:'',complete:false,nativeMessage:true,siteId:'chat-message-separate-prose'});
      generating=true;
      await tick();
      assert.equal(events.some(e=>e.kind==='assistant'||e.kind==='blocked'),false,
        'a late streaming shell keeps the prepared images pending');
      Object.assign(rows.at(-1),{role:'assistant',text:trailing,complete:true});
      generating=false;
    } else if (trailing) add('separate-prose',trailing);
    await step();await step(3200);await step();
    const reply=events.find(e=>e.kind==='assistant');
    assert.ok(reply,'ten verified images are available without any prose');
    assert.equal(reply.text,trailing);
    assert.equal(reply.images.length,10);
    assert.equal(events.filter(e=>e.kind==='assistant').length,1);
    return;
  }
  if (mode==='literal before images') {
    const sources=Array.from({length:10},(_,i)=>'native-card-'+(i+1));
    add('all-images','Done. I will begin now.',{images:sources.map(()=>({})),sources});
    await step();await step(3200);await step();
    assert.equal(events.filter(e=>e.kind==='assistant').length,0,'introductory prose does not close the batch');
    rows.at(-1).text+='\n\nDone.';
    rows.at(-1).postImageProse='Done.';
    await step();await step(3200);await step();
    assert.equal(events.filter(e=>e.kind==='assistant').length,1);
    return;
  }
  if (mode==='same native reply') {
    const sources=Array.from({length:10},(_,i)=>'native-card-'+(i+1));
    add('all-images','Вот десять значков.',{images:sources.map(()=>({})),sources});
    rows.at(-1).postImageProse=rows.at(-1).text;
    await step();await step(3200);await step();
    const reply=events.find(e=>e.kind==='assistant');
    assert.ok(reply,'a final section in the same native reply completes the batch');
    assert.equal(reply.text,'Вот десять значков.');
    assert.deepEqual(Array.from(reply.images,image=>image.data),sources);
    return;
  }
  if (mode==='summary') add('native-progress','',{pending:true,progressOnly:true});
  for(let index=1;index<=count;index++){
    generating=index%2===0 && index<count;
    const source=mode==='repeated source' && index===5 ? 1 : index;
    add(index,mode==='summary' ? '' : 'Image '+index,{images:[{}],sources:['source-'+source]});
    await step();await step(3200);await step();
    assert.equal(events.filter(e=>e.kind==='assistant').length,0,
      'an intermediate image must not complete the native turn');
  }
  const final=mode==='summary' ? 'The series contains ten swatches.' :
    mode==='incomplete result' ? 'Image generation failed after five pictures.' : 'Die Karten sind angehängt.';
  if (mode==='unfinished shell') {
    rows.push({role:'unknown',text:'',complete:false,nativeMessage:true,siteId:'chat-message-final'});
    await step();await step(119000);await step(3000);
    assert.match(events.find(e=>e.kind==='blocked')?.text ?? '',/5 of 10.*unfinished/);
    assert.equal(events.filter(e=>e.kind==='assistant').length,0);
    return;
  }
  if (mode==='repeated source') {
    assert.match(events.find(e=>e.kind==='blocked')?.text ?? '',/reused an image source/);
    assert.equal(events.filter(e=>e.kind==='assistant').length,0);
    return;
  }
  add('final',final);
  if (mode.startsWith('replaced ')) {
    await step();
    now+=3200;notify();
    await new Promise(resolve=>setImmediate(resolve));
    if (mode==='replaced while extending') {
      add('extra','Image 11',{images:[{}],sources:['source-11']});
      notify();
    }
    rows[3].artifact={images:[{}],sources:['replacement-source']};
    await tick();
    assert.equal(events.filter(e=>e.kind==='assistant').length,0);
    assert.match(events.find(e=>e.kind==='blocked')?.text ?? '',/changed before delivery/);
    return;
  }
  await step(); await step(3200); await step();
  const replies=events.filter(e=>e.kind==='assistant');
  assert.equal(replies.length,1);
  assert.equal(replies[0].replyTo,events.find(e=>e.kind==='user').id);
  assert.ok(replies[0].text.includes(final));
  if (mode==='incomplete result') assert.match(replies[0].text,/5 of 10 requested/);
  assert.deepEqual(Array.from(replies[0].images,im=>im.data),
    Array.from({length:count},(_,i)=>'source-'+(i+1)));
  await step(3200);
  assert.equal(events.filter(e=>e.kind==='assistant').length,1);
});
}

for (const failure of ['unrelated source','missing native card']) test('fresh paired artwork is returned once, then the next turn stops for '+failure,async()=>{
  const chat='https://arena.ai/agent/example';
  const oldImage={},newImage={},old={images:[oldImage],sources:['old']},fresh={images:[newImage],sources:['new']};
  const rows=[{role:'user',text:'past'},{role:'assistant',text:'old image',complete:true,siteId:'chat-message-old',artifact:old,artifactsPending:true}];
  let listen,tick,changed,encoded=0,now=10000;
  const wire=[{mediaType:'image/png',data:'AAAA'}], events=[];
  const ctx=vm.createContext({crypto,URL,location:{href:chat},Date:class extends Date{static now(){return now;}},
    document:{documentElement:{}},addEventListener(){},MutationObserver:class{constructor(fn){changed=fn;}observe(){}},
    setInterval:fn=>{tick=fn;},ArenaGeneratedImages:{activate(){},encode:async artifact=>{
      assert.equal(artifact.images[0],newImage);encoded++;
      if (failure==='unrelated source' && encoded===1) rows.at(-1).artifact={...fresh,pending:true};
      return wire;
    }},
    ArenaPage:class{rows(){return rows.map(row=>({...row}));}state(){return {idle:true,ready:true,field:{},value:''};}},
    chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listen=fn},sendMessage:async msg=>{
      if(msg.event)events.push(msg.event);return {ok:true,job:null};
    }}}
  });
  for(const file of ['core.js','content.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  const control=msg=>new Promise(resolve=>listen(msg,{id:'test'},resolve));
  const prep=await control({type:'prepare',chat});
  assert.equal((await control({type:'attach',chat,pageKey:prep.pageKey,binding:'b1'})).ok,true);
  await tick();assert.equal(encoded,0);
  rows.push({role:'user',text:'Please generate an image of a teapot.'},{role:'assistant',text:'Caption',complete:true,siteId:'uuid-not-prefixed',nativeMessage:true});
  changed();await tick();
  assert.equal(events.some(e=>e.kind==='assistant'),false,'completed native answer settles before sending text');
  now+=1800;changed();await tick();
  assert.equal(events.some(e=>e.kind==='assistant'),false,'caption after previous settle window does not complete a requested image');
  rows.at(-1).artifact={pending:true};rows.at(-1).artifactsPending=true;
  now+=32000;changed();await tick();assert.equal(encoded,0);
  assert.equal(events.some(e=>e.kind==='blocked'),false,'late pending artwork still waits after thirty seconds');
  rows.at(-1).artifact=fresh;
  changed();await new Promise(resolve=>setImmediate(resolve));await tick();await tick();
  if (failure==='unrelated source') {
    assert.equal(events.some(e=>e.kind==='assistant'),false,'progress appearing during encoding keeps the turn open');
    rows.at(-1).artifact=fresh;
    changed();await new Promise(resolve=>setImmediate(resolve));await tick();
  }
  const answers=events.filter(e=>e.kind==='assistant');
  const attempts=failure==='unrelated source'?2:1;
  assert.equal(encoded,attempts);assert.equal(answers.length,1);
  assert.deepEqual(answers[0].images,wire);assert.equal(answers[0].replyTo,events.find(e=>e.kind==='user').id);
  const missing=failure==='missing native card';
  const second={role:'assistant',text:'Caption',complete:true,siteId:'chat-message-bad'};
  if (!missing) Object.assign(second,{artifactsPending:true,artifact:{error:'Unrelated image source.'}});
  rows.push({role:'user',text:'Нарисуй маяк.'},second);
  changed();now+=1200;await tick();
  if (missing) {
    now+=121000;await tick();
    assert.ok(events.some(e=>e.kind==='blocked' && e.text.includes('no verified generated image')));
  } else assert.ok(events.some(e=>e.kind==='blocked' && e.text.includes('Unrelated image source')));
  assert.equal(events.filter(e=>e.kind==='assistant').length,1);
  assert.equal(encoded,attempts);
});
