# 字幕校时工作台（Subtitle Timing Workbench）

把**逐词转写**（带起止毫秒）与**镜头切点**排版成符合规则的字幕，在浏览器里校对、锁定、确认后导出 **WebVTT**。本地运行：Node.js + Express + SQLite（better-sqlite3）+ 原生前端，无外部服务依赖。

## 功能

- **导入**：逐词转写 `words: [{text, start_ms, end_ms}]` + 镜头切点 `cuts: [ms]`。
  时间无效（开始 ≥ 结束、负值、非整数）或**倒序/重叠**的词段一律**拒绝导入**并逐条说明。
- **排版规则**：单条最大字数、最短显示时长（ms）、每秒最多字数，可随时修改。
- **排版保证**：按原词序覆盖全部词（每词恰好一次）、字幕互不重叠、不跨镜头切点、不缩短任何词本身的时段（只在空闲间隙内向后/向前扩展）。
- **冲突报告**：规则无法同时满足时，列出**受影响词段 + 冲突条件**（如"切点落在词内部"、"可用空间 450ms 小于最短时长 1000ms"），**不输出貌似完整的结果**，也不改动现有字幕。
- **锁定**：已校对的字幕可锁定 🔒，重新排版只改未锁定部分，锁定条原样保留。
- **修订提议（校对）**：校对者可针对未锁定字幕提交**一组待采纳修订**（不改正式字幕）；预览并列原值/当前值/建议值并按当前数据核对整组；采纳时事务内再次核对行版本与规则版本、校验整版后整组生效，任一过期或违规则整组不生效；已采纳提议重复采纳是幂等空操作，历史可查。
- **乐观锁**：规则与每条字幕都带版本号，过期提交返回 `409` 与当前内容；字幕集整体有 `sub_version`，重排/导出携带以防并发覆盖。
- **导出**：确认后生成按时间升序的 WebVTT，存为**不可变版本快照**，可随时再次下载；后续修改（含采纳提议）不影响旧文件。导出前会完整校验（含锁定字幕），违规则拒绝并列出问题。

## 启动

### Docker（推荐，一条命令）

```bash
docker compose up --build
```

Dockerfile 负责安装依赖，启动时自动建表（`src/db.js`），数据库为空且 `SEED_DEMO=true` 时播种一个演示项目（含自动排版结果）。

### 本地开发

```bash
npm ci
npm start          # 或 PORT=8080 DB_PATH=./my.db node server.js
```

### 访问

打开 **http://localhost:3000**（本地 `npm start` 同理；`PORT` 环境变量可改端口）。

### 测试

```bash
npm test           # node:test，覆盖排版引擎与全部 API
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `./data/subtitles.db`（容器内 `/data/subtitles.db`） | SQLite 文件路径，启动时自动初始化表结构 |
| `SEED_DEMO` | `true` | 数据库为空时播种"演示项目：江边茶馆"；设 `false` 关闭 |

Compose 默认把 SQLite 挂到命名卷 `subtitle-data` 持久化（含所有导出版本快照）。

## 使用流程

1. **导入**：粘贴 JSON（或点"载入示例"），填项目名则新建项目，留空则导入当前项目（已有字幕时需勾选确认覆盖）。`examples/sample.json` 是同款示例。
2. **设规则**：最大字数 / 最短时长 / 每秒字数 → 保存（版本号 +1）。
3. **排版**：点"重新排版（仅未锁定字幕）"。有冲突时红色面板逐条列出词段与原因，修正数据或放宽规则后重试。
4. **校对**：直接在列表里改文本/时间（保存时校验：不得缩短词时段、不得重叠、不得跨切点），校对好的点"锁定"。
   多人校对可走**修订提议**："④ 修订提议"面板填入 JSON 提交 → 预览核对 → 采纳整组生效（见下文「修订提议（校对流程）」）。
5. **导出**：点"确认当前字幕并导出 WebVTT"，生成 v1、v2…… 任意版本可随时重新下载。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/projects` | 项目列表 |
| `POST` | `/api/projects` | 新建项目（可同时带 `words`/`cuts`/`rules`） |
| `GET` | `/api/projects/:id` | 项目完整数据（词、切点、规则、字幕、导出列表） |
| `POST` | `/api/projects/:id/import` | 替换转写与切点；已有字幕时需 `{"force": true}`（会清空字幕） |
| `PUT` | `/api/projects/:id/rules` | 改规则，需带当前 `version`，过期返回 `409` + 当前规则 |
| `POST` | `/api/projects/:id/layout` | 重排未锁定字幕，需带 `sub_version`；冲突返回 `422` + `conflicts` |
| `PATCH` | `/api/projects/:id/subtitles/:sid` | 编辑/锁定单条，需带行 `version`，过期返回 `409` + 当前行 |
| `POST` | `/api/projects/:id/proposals` | 提交一组修订提议（快照原值与规则版本，不改正式字幕） |
| `GET` | `/api/projects/:id/proposals` | 提议历史列表（状态、条数、时间） |
| `GET` | `/api/projects/:id/proposals/:pid` | 提议明细：逐项原值与建议值 |
| `GET` | `/api/projects/:id/proposals/:pid/preview` | 预览：并列原值/当前值/建议值，按当前数据核对整组并列出冲突 |
| `POST` | `/api/projects/:id/proposals/:pid/adopt` | 采纳：事务内核对版本并校验整版，整组生效；已采纳则幂等空操作 |
| `POST` | `/api/projects/:id/exports` | 校验并确认导出（可带 `sub_version` 防呆），生成新版本快照 |
| `GET` | `/api/projects/:id/exports` | 导出版本列表 |
| `GET` | `/api/projects/:id/exports/:version` | 下载某版本 `.vtt`（内容创建后不变） |

错误格式统一：`400` 请求非法；`404` 不存在；`409` 版本过期（带 `current`）；`422` 校验/冲突失败（带 `errors` 或 `conflicts`，每项含 `word_start`/`word_end` 与中文说明）。

## 修订提议（校对流程）

校对者针对**未锁定字幕**提交一组待采纳修订。提议保存各项原值快照与**当时规则版本**，提交本身**不改动正式字幕**；采纳时才在同一事务里整组生效。

**提交**（`POST /api/projects/:id/proposals`）——逐项给出字幕ID、读取时行版本、替代文本，起止毫秒可选（缺省表示不修改该项时间），可附整组与逐项说明：

```bash
curl -X POST http://localhost:3000/api/projects/1/proposals \
  -H 'Content-Type: application/json' \
  -d '{
    "note": "第一轮校对",
    "items": [
      {"subtitle_id": 1, "version": 1, "text": "你好朋友", "end_ms": 1100, "note": "称呼统一"},
      {"subtitle_id": 2, "version": 1, "text": "欢迎光临本店"}
    ]
  }'
# 201 → {"id":1,"status":"pending","rules_version":1,"items":[{"original":{...},"suggested":{...}}, ...]}
```

**空组、重复字幕ID、非法时间（非整数/负值/开始≥结束）、空文本、目标不存在或已锁定 → `422` 整组拒收**，`errors` 逐条说明。

**预览**（`GET /api/projects/:id/proposals/:pid/preview`）——逐项并列原值（提交时快照）/当前值/建议值，并按**当前**词区间、词时段、切点、相邻字幕及字数/时长/字速规则核对整组候选：

```bash
curl http://localhost:3000/api/projects/1/proposals/1/preview
# → {"adoptable":true,"conflicts":[],
#    "items":[{"original":{"text":"你好世界",...},"current":{...},"suggested":{"text":"你好朋友",...}}]}
# 有冲突时 conflicts 逐项给出类型与说明：
#   target_missing / target_locked / version_stale / rules_version_stale（过期类）
#   word_span_shortened / cut_crossed / overlap / max_chars / min_duration / max_cps（校验类）
```

**采纳**（`POST /api/projects/:id/proposals/:pid/adopt`）——事务内再次核对目标仍存在且未锁定、各行版本与规则版本，校验整版后写入全部修订并推进字幕集版本：

```bash
curl -X POST http://localhost:3000/api/projects/1/proposals/1/adopt
# 200 → {"status":"adopted","sub_version":2,"subtitles":[...]}
# 任一行被改过/锁定/删除或规则已更新 → 409 {"reasons":[...],"current":{当前字幕与规则}}，整组不生效
# 修订后整版违反规则           → 422 {"conflicts":[...]}，整组不生效
# 重复采纳已采纳提议           → 200 {"already_adopted":true}，不再改动任何字幕（幂等）
```

**历史**（`GET /api/projects/:id/proposals` / `:pid`）随时可查；已采纳提议重复提交不会再改字幕；旧导出快照不受采纳影响。

```bash
curl http://localhost:3000/api/projects/1/proposals      # 列表：状态/条数/采纳时间
curl http://localhost:3000/api/projects/1/proposals/1    # 明细：逐项原值与建议值
```

## 排版约束与冲突处理

对每条字幕强制满足：文本 ≤ `max_chars` 字、时长 ≥ `min_duration_ms`、字数/秒 ≤ `max_cps`；
对整版强制满足：词全覆盖且顺序不变、字幕不重叠、不跨切点、词时段不被缩短。
词是不可拆分的最小单元，因此会出现规则确实无法同时满足的情况，例如：

- 切点落在某个词的时段内部（跨切点 ↔ 缩短词时段，二者必违其一）→ 报 `cut_inside_word`；
- 单个词超过最大字数 → 报 `max_chars`；
- 词段太密，最短时长/每秒字数在相邻字幕与切点夹出的空间内放不下 → 报 `duration`（含所需毫秒数与可用空间）。

此时接口返回 `422` 与完整冲突列表，**不写入任何字幕**；调整切点、规则或转写后重新排版即可。

## 目录结构

```
server.js            入口：初始化 SQLite、播种演示数据、启动 HTTP
src/db.js            连接与建表（projects/words/shots/rules/subtitles/proposals/proposal_items/exports）
src/layout.js        排版引擎（纯函数）：切点分析 → 分段 → 定时 → 结构自检
src/validate.js      导入与编辑校验
src/proposals.js     修订提议（纯函数）：提交校验 → 假设字幕集 → 预览核对
src/vtt.js           WebVTT 序列化
src/routes.js        Express API
public/              前端（原生 HTML/CSS/JS 单页）
examples/sample.json 示例转写与切点
test/                node:test 单元 + API 集成测试
Dockerfile / docker-compose.yml
```
