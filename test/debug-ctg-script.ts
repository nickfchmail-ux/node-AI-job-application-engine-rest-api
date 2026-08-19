// Find which script block contains the CTgoodjobs job description
import * as fs from "fs";

const html = fs.readFileSync("ctg_detail.html", "utf-8");
const markerIdx = html.indexOf("Higher Diploma");

// Find the enclosing <script ...> ... </script>
const openRegex = /<script([^>]*)>/g;
let lastOpen = -1;
let lastOpenAttrs = "";
let m: RegExpExecArray | null;
while ((m = openRegex.exec(html)) !== null && m.index < markerIdx) {
  lastOpen = m.index;
  lastOpenAttrs = m[1];
}
const closeIdx = html.indexOf("</script>", markerIdx);
console.log(
  "enclosing script open at:",
  lastOpen,
  "attrs:",
  JSON.stringify(lastOpenAttrs),
);
console.log("closing script at:", closeIdx);
console.log("script content length:", closeIdx - lastOpen);

// Show the beginning of that script block
const scriptContent = html.slice(lastOpen, Math.min(lastOpen + 300, closeIdx));
console.log("--- script start ---");
console.log(scriptContent.slice(0, 300));
