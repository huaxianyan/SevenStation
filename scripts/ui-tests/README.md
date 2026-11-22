# 界面检查脚本

把 `wwwroot` 里的 `appearance.js` + `app.js` 塞进 jsdom，直接喂事件看 DOM。
不用起 Core、不用开浏览器，改完前端跑一遍就知道分段、展开、草稿这些有没有被改坏。

```bash
cd scripts/ui-tests
npm install          # 只装 jsdom，装一次就够
npm test             # 依次跑所有 *.test.js
```

| 脚本 | 盯的是什么 |
| --- | --- |
| `turn-segments.test.js` | 一轮按「工作 → 正文 → 工作 → 正文」分段；详情就地展开/收起；正文流式只换最后一段；空白思考不画 |
| `session-drafts.test.js` | 草稿按会话隔离，切会话不串 |
| `work-detail-keep.test.js` | 新步骤只追加不重画，展开的详情不会被收起；没贴底时重画不动滚动位置 |

这些脚本原来的临时版本放在 `E:/tmp`，被一次清理误删过，所以搬进仓库了：**别再把检查脚本放在临时目录**。
