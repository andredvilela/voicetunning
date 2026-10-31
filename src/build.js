const fs=require('fs'),path=require('path');
const d=path.join(__dirname,'..','site');
const tpl=fs.readFileSync(path.join(__dirname,'index.template.html'),'utf8');
const wk=fs.readFileSync(path.join(d,'voice-tuner.js'),'utf8');
if(/<\/script/i.test(wk)) throw new Error('worklet contains </script');
fs.writeFileSync(path.join(d,'index.html'),tpl.replace('/*WORKLET*/',()=>wk));
const app=tpl.match(/<script id="app">([\s\S]*?)<\/script>/)[1];

console.log('built');
