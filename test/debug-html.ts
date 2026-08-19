// Isolate the htmlToText cleaning to debug the CTgoodjobs issue
import * as fs from "fs";

const html = fs.readFileSync("ctg_detail.html", "utf-8");
console.log("original len:", html.length);

// Step 1: where does 'Higher Diploma' sit relative to script tags?
const markerIdx = html.indexOf("Higher Diploma");
console.log("Higher Diploma idx:", markerIdx);

// Count script blocks before the marker
const before = html.slice(0, markerIdx);
const scriptOpenCount = (before.match(/<script/g) || []).length;
const scriptCloseCount = (before.match(/<\/script>/g) || []).length;
console.log(
  "script open before marker:",
  scriptOpenCount,
  "close:",
  scriptCloseCount,
);
console.log("balanced:", scriptOpenCount === scriptCloseCount);

// Step 2: is the marker inside a script block?
const lastScriptOpen = before.lastIndexOf("<script");
const lastScriptClose = before.lastIndexOf("</script>");
console.log("last script open before marker:", lastScriptOpen);
console.log("last script close before marker:", lastScriptClose);
console.log("marker inside unclosed script?", lastScriptOpen > lastScriptClose);
