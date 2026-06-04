import Parser from "rss-parser";
const UA="Mozilla/5.0 (compatible; ReaderCurator/1.0)";
function strip(s=""){return s.replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&#8217;|&#039;|&#39;/g,"'").replace(/&#8220;|&#8221;|&quot;/g,'"').replace(/\s+/g," ").trim();}
const p=new Parser({timeout:14000,headers:{"user-agent":UA},customFields:{item:[["content:encoded","ce"],["media:content","mc",{keepArray:true}]]}});
const feeds=[
 ["Scherzo","es","https://scherzo.es/feed/"],
 ["Platea Magazine","es","https://www.plateamagazine.com/feed"],
 ["Beckmesser","es","https://www.beckmesser.com/feed/"],
 ["The Guardian · Classical","en","https://www.theguardian.com/music/classicalmusicandopera/rss"],
 ["The Guardian · Stage","en","https://www.theguardian.com/stage/rss"],
 ["VAN Magazine","en","https://van-magazine.com/mag/feed/"],
 ["Slipped Disc","en","https://slippedisc.com/feed/"],
 ["Operawire","en","https://operawire.com/feed/"],
];
const cutoff=Date.now()-1000*3600*24*7;
for(const [src,lang,url] of feeds){
  try{
    const f=await p.parseURL(url);
    const items=(f.items||[]).filter(it=>{const t=Date.parse(it.isoDate||it.pubDate||"");return isNaN(t)||t>=cutoff;}).slice(0,5);
    for(const it of items){
      let img=null;
      if(Array.isArray(it.mc)&&it.mc[0]?.$?.url)img=it.mc[0].$.url;
      else if(it.enclosure?.url)img=it.enclosure.url;
      else {const m=String(it.ce||it.content||"").match(/<img[^>]+src=["']([^"']+)["']/i);if(m)img=m[1];}
      console.log(JSON.stringify({src,lang,t:(it.isoDate||it.pubDate||"").slice(0,10),title:strip(it.title||""),url:it.link,img,snip:strip(it.ce||it.content||it.contentSnippet||"").slice(0,700)}));
    }
  }catch(e){console.log("ERR "+src+": "+e.message);}
}
