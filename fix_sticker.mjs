import fs from "node:fs";

const botPath = "e:/vscode-test/微信聊天/src/bot.js";
let content = fs.readFileSync(botPath, "utf8");
const startMarker = "let stickerFile = stickerMgr.search(keyword);";

let idx = 0;
let count = 0;
while (true) {
  idx = content.indexOf(startMarker, idx);
  if (idx === -1) break;

  // Find end: the } closing the "if (!segText) { ... continue; }" block
  let ifIdx = content.indexOf("if (!segText)", idx);
  if (ifIdx === -1) break;
  let continueIdx = content.indexOf("continue;", ifIdx);
  if (continueIdx === -1) break;
  let blockEnd = content.indexOf("}", continueIdx);
  if (blockEnd === -1) break;
  blockEnd += 1;

  const oldBlock = content.substring(idx, blockEnd);
  const isProactive = oldBlock.includes("proactive sticker");
  const prefix = isProactive ? "friend.target" : "target";
  const logP = isProactive ? "[proactive sticker]" : "[sticker]";

  const newBlock = `// 优先在线搜索，失败则用微信emoji
          const online = await stickerMgr.searchOnline(keyword);
          if (online) {
            try {
              await ${prefix}.say(FileBox.fromUrl(online.url, online.filename));
              console.log(\`${logP} "\${keyword}" → 在线\`);
            } catch (e) {
              console.log(\`${logP} 发送失败: \${e.message}\`);
            }
          } else {
            const emoji = stickerMgr.search(keyword);
            if (emoji) {
              segText = segText ? \`\${segText}\${emoji}\` : emoji;
            }
          }

          if (!segText) {
            console.log(\`${logP} "\${keyword}" 无匹配，跳过该段\`);
            continue;
          }`;

  content = content.substring(0, idx) + newBlock + content.substring(blockEnd);
  console.log(`Replaced ${isProactive ? "proactive" : "regular"} at ${idx}`);
  count++;
  idx = idx + newBlock.length;
}

console.log(`Total: ${count} blocks replaced`);
fs.writeFileSync(botPath, content, "utf8");
