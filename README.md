# Codex 工作流監控外掛 & 多模型子代理自動配置方案

> **版本：`v0.3.3`**｜適用於 **ChatGPT Desktop / Codex**（MCP Apps 側邊分頁）與 **Codex CLI**  
> 內含兩項可獨立或合併使用的元件：
> 1. **`codex-workflow-monitor` 本機外掛**：以終端機 TUI 數據流風格即時視覺化呈現單模型與多子代理運行狀態，預設唯讀讀取本機狀態，開箱即用。
> 2. **四模型多子代理自動配置規格**：一份可直接交給 Codex 執行的安全配置手冊（Phase A 唯讀 Diff 預覽 → 人工批准 → Phase B 備份寫入 → Phase C 嚴格驗證），協助導入 `Sol` / `Luna` / `Terra` / `Astra` 協作架構。

---

## 目錄

- [功能亮點](#功能亮點)
- [系統架構與節點連動](#系統架構與節點連動)
- [環境需求與離線預覽](#環境需求與離線預覽)
- [快速開始一：安裝 Codex 工作流監控外掛](#快速開始一安裝-codex-工作流監控外掛)
- [快速開始二（選用）：一鍵配置四模型多子代理](#快速開始二選用一鍵配置四模型多子代理)
- [專案目錄與提供的 MCP 工具](#專案目錄與提供的-mcp-工具)
- [隱私、安全與隔離邊界](#隱私安全與隔離邊界)
- [Codex 多模型子代理自動配置完整規格](#codex-多模型子代理自動配置完整規格)
  - [0. 給 Codex 的執行指令與不可違反限制](#0-給-codex-的執行指令與不可違反限制)
  - [1. Preflight 唯讀檢查](#1-preflight-唯讀檢查不得寫入)
  - [2. 寫入目標與設定檔模板](#2-寫入目標與設定檔模板)
  - [3. 全域 AGENTS.md 協作規範](#3-全域-agentsmd-協作規範)
  - [4. 分階段執行流程（Phase A-C）](#4-分階段執行流程phase-a-c)
  - [5. 驗收條件、反模式與交付報告格式](#5-驗收條件反模式與交付報告格式)
- [版本更新摘要](#版本更新摘要)
- [授權與作者](#授權與作者)
- [官方參考資料](#官方參考資料)

---

## 功能亮點

### 1. TUI 數據流視覺化監控面板（`codex-workflow-monitor`）
- **終端機點陣數據流風格**：保留點陣框線、動態正交數據連線與流動光點，專為 ChatGPT Desktop／Codex 的 `thread` / `global` 側邊分頁打造（繁體中文介面）。
- **三態發光邏輯（只點亮正在運行的部分）**：
  - **運行中（發光）**：正在推理的主模型、活躍中的工具模組與正在執行的子代理與連線高亮發光。
  - **已完成（熄滅）**：已執行完畢的節點自動熄滅並標示完成狀態。
  - **未使用（暗化／隱藏）**：未觸發的功能模組與子代理低調待命，並可透過頂部 **「精簡隱藏」** 一鍵收合未用節點。
- **單模型與多子代理自動適配**：
  - 單獨使用單一模型（例如 `GPT-6.2-Sol`）時，僅呈現主模型、即時活動與已啟用的功能模組，不佔用多餘子代理空間。
  - 動態派發任何子代理（標準 `explorer` / `audit` / `advisor`，並向後相容舊版 `search` / `grep` 或自訂子代理）時，自動展開子代理協作區並獨立追蹤各代理進度。
- **零侵入即開即用**：透過 Node 內建唯讀 `node:sqlite` 直接觀測 `$CODEX_HOME/state_*.sqlite`、`thread_history_*.sqlite` 與活躍執行緒的 `rollout-*.jsonl` 尾端中繼資料；同時相容合併外掛內建的選用 Hooks（`~/.codex-workflow-monitor/events.jsonl`）。
- **完整即時指標與範圍切換**：
  - 支援頂部 **「對話（Session）／輪次（Turn）」** 統計範圍即時切換。
  - 顯示主模型、功能模組與子代理的緩存命中率、調用次數、工具呼叫數、即時運行時間（每秒更新）與整體（主代理 + 子代理）Token 總用量。
  - 自動過濾監控外掛自身的工具輪詢（`open_workflow_monitor`、`read_workflow_events`、`clear_workflow_events`），避免誤觸發光。

### 2. 安全可控的四模型多子代理協作方案（選用）
- **增量導入、絕不暴力覆寫**：採用 Phase A（唯讀盤點 + Unified Diff 預覽）→ 人工批准 → Phase B（時間戳記備份 + 安全寫入）→ Phase C（TOML、Hook 與 `codex --strict-config doctor` 驗證）三階段流程。
- **保留既有設定**：不覆蓋既有 MCP 伺服器、外掛、沙盒模式、核准政策或其他自訂代理；若原主模型與目標衝突，先詢問使用者選擇。
- **反誤 Fork 與低冷啟動開銷**：覆寫內建 `explorer` 避免角色撞車，以 `PreToolUse` Hook 硬攔截跨模型 `fork_turns="all"`，並在子代理關閉非必要的 `apps`/`plugins`/`memories` 與全域 `skills` 注入以縮減 ~23.7% 固定前綴。
- **跨版本 TOML 相容**：避開舊版 `codex-cli 0.162.x` 與新版 `0.170.0+` 在 `[agents]` 表上的相容性陷阱。

---

## 系統架構與節點連動

外掛可單獨用於日常單模型開發；若進一步套用本儲存庫的四模型子代理配置，面板會依 `agent_role`／`agent_type`／模型名稱自動上色並對應到專屬位置：

```text
┌───────────────────┐     ┌────────────────────────────────────────┐     ┌──────────────────┐
│  ASTRA 顧問欄     │◄───►│  主模型（Sol · gpt-6.2-sol / high）    │────►│ RUNTIME 執行資源 │
│  (advisor / gold) │     │  即時狀態 · 回合 · 緩存 · 耗時         │     │ 緩存命中率·總Token│
│  · 規劃鎖定前     │     └──────────────────┬─────────────────────┘     └──────────────────┘
│  · 連續失敗兩次   │                        ▼
│  · 交付終審關卡   │     ┌────────────────────────────────────────┐
│  [ASTRA CHECKED]  │     │  功能與調度層（9 大能力模組即時高亮）  │
└───────────────────┘     │  推理 · 搜尋 · 終端 · 編修 · MCP · ... │
                          └──────────────────┬─────────────────────┘
                                             ▼ （僅於派發子代理時動態點亮，強制 fork_turns="none"）
                          ┌────────────────────────────────────────┐
                          │   Luna Explorer   │    Terra Audit     │ （亦相容舊版 search/grep 與自訂代理）
                          └──────────────────┬─────────────────────┘
                                             ▼
                          ┌────────────────────────────────────────┐
                          │  back to 主模型（整合交付與總結）      │
                          └────────────────────────────────────────┘
```

### 四模型角色與監控面板對應表

| 角色 | 代理名稱 (`name`) | 顯示別名 (`nickname_candidates`) | 預設模型 (`model`) | 推理程度 | 面板節點與色系 | 工作職責 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 主代理 | 主會話 | `Sol` | `gpt-6.2-sol` | `high` | 中央主模型（紫色） | 需求理解、編碼、修改、整合與最終交付（複雜長任務可手動升 `xhigh`） |
| 唯讀探索 | `explorer`（覆寫內建） | `Luna Explorer` | `gpt-6-luna` | `medium` | 子代理區（青色） | Repository 廣度探索、檔案定位、符號定義、引用與呼叫鏈分析（合併原 `search`/`grep`） |
| 獨立驗證 | `audit` | `Terra Audit` | `gpt-6.1-terra` | `high` | 子代理區（綠色） | diff 審查、範圍安全測試、回歸與資安檢查，以及附截圖／本機頁面時的 UI／視覺驗收 |
| 高階顧問 | `advisor` | `Astra Advisor` | `gpt-6.2-astra` | `xhigh` | 左側顧問欄（金色） | 重大架構把關、連續失敗根因分析、深層系統風險與重要交付終審 |

> **模型版本與視窗備註：** 目前 Codex 官方模型目錄中 `gpt-6.2-sol` 與 `gpt-6.1-terra` 為 **500K** 上下文視窗（Terra 家族目前最新為 `gpt-6.1-terra`，且官方標示擅長視覺理解與 Computer Use），`gpt-6.2-astra` 與 `gpt-6-luna` 為 **272K** 上下文視窗。因此跨模型派發必須一律使用 `fork_turns="none"`，避免將長 Sol 對話整包複製導致緩存失效或撐爆 272K 視窗。執行配置前仍會由 `codex debug models` 或 `$CODEX_HOME/models_cache.json` 實際核實。

### 功能與調度層自動分類（9 大能力模組）
無論單模型或子代理，工具呼叫皆自動歸類至以下模組並即時統計次數與運行狀態：`深度推理`、`搜尋與讀取`、`終端指令`、`檔案編修`、`MCP 工具`、`網路檢索`、`影像處理`、`脈絡壓縮`、`計畫規劃`。

---

## 環境需求與離線預覽

### 環境需求
- **Node.js**：`22.5+`（建議 **`24+`**，以使用內建唯讀 `node:sqlite` 直接觀測本機 Codex 狀態資料庫）。
- **Codex CLI / ChatGPT Desktop（Codex）**：支援本機 Plugin Marketplace 與 MCP Apps 側邊分頁之版本（已於 `codex-cli 0.170.0` 驗證指令與設定相容性）。
- **Python 3（選用）**：僅在啟用外掛內建 Hooks（`hooks/record_event.py`）時需要；未啟用 Hook 或無 Python 環境時，外掛仍可透過 `node:sqlite` 正常監控。

### 免安裝即時預覽介面
在安裝外掛前，可直接以瀏覽器開啟專案根目錄的 [`preview-zh.html`](./preview-zh.html)，內建三種互動示範情境可供切換體驗：
- **單模型 GPT-6.2-Sol**
- **呼叫 Subagent 協作**
- **全部完成（熄滅）**

---

## 快速開始一：安裝 Codex 工作流監控外掛

### 1. 下載儲存庫並建置驗證外掛

> 請先在本機安裝依賴並編譯前端橋接腳本（`dist/bridge.js`），再透過本機 Marketplace 註冊，確保 MCP 伺服器與 UI 資源完整可用。

**macOS / Linux（Bash / Zsh）：**
```bash
git clone https://github.com/Baiming0722/Codex_Side_Workflow.git
cd Codex_Side_Workflow

cd plugins/codex-workflow-monitor
npm install
npm run build
npm run check
npm test
cd ../..
```

**Windows（PowerShell）：**
```powershell
git clone https://github.com/Baiming0722/Codex_Side_Workflow.git
Set-Location Codex_Side_Workflow

Set-Location plugins\codex-workflow-monitor
npm install
npm run build
npm run check
npm test
Set-Location ..\..
```

### 2. 加入本機 Marketplace 並安裝外掛

在**專案根目錄**（含 `.agents/plugins/marketplace.json` 的資料夾）執行：

```bash
codex plugin marketplace add .
codex plugin add codex-workflow-monitor@codex-workflow-local
```

完成後，重新開啟 **ChatGPT Desktop／Codex**（或重載對話側邊分頁），在側邊分頁或工具選單點選 **Codex Workflow** 即可啟用即時監控。

### 3. 更新已安裝的舊版外掛

當拉取新版本並重新執行 `npm install && npm run build` 後，移除舊快取並重新安裝：

```bash
codex plugin remove codex-workflow-monitor@codex-workflow-local
codex plugin add codex-workflow-monitor@codex-workflow-local
```

---

## 快速開始二（選用）：一鍵配置四模型多子代理

本步驟為**完全選用**。如果您希望將全域 Codex 配置為「Sol 主導實作 + Luna 探索搜尋 + Terra 獨立審查 + Astra 高階顧問」，**不需要手動複製貼上設定檔**——直接將本專案交給 Codex，並貼上以下啟動指令，讓 Codex 依照下方完整規格執行安全的兩階段配置：

```text
請讀取本儲存庫的 README.md 中「Codex 多模型子代理自動配置完整規格」章節，並從第 0 節開始嚴格遵守執行。
目標是配置本機 Codex 的全域多模型子代理：Sol 主代理 (gpt-6.2-sol / high)、Luna explorer (gpt-6-luna / medium，覆寫內建 explorer)、Terra audit (gpt-6.1-terra / high，含 diff/測試與視覺驗收)、Astra advisor (gpt-6.2-astra / xhigh)，並行上限 max_concurrent_threads_per_session = 3，並配置 PreToolUse 防跨模型誤 Fork Hook（強制 fork_turns="none"）與子代理 Prompt 瘦身設定。
先執行 Phase A：盤點當前環境、核實 models_cache.json 與 CLI 支援情況，產生所有預計變更的完整 Unified Diff（若我現有 config.toml 的主模型設定不同，或已有舊版 search.toml / grep.toml，請列出選項讓我決定處理方式）。
這一輪禁止修改檔案、安裝工具、改變權限或建立 Worktree。
完成後等待我回覆「繼續」，才可進入 Phase B 套用並執行 Phase C 驗證。
```

**操作方式：**
1. 貼上上述指令後，檢視 Codex 回報的環境盤點結果、模型支援狀態、主模型保留選項與完整 Unified Diff。
2. 確認不會破壞您既有設定後，回覆 **「繼續」**，Codex 才會先建立時間戳記備份，再套用設定並執行 TOML 與 CLI 嚴格檢查。

---

## 專案目錄與提供的 MCP 工具

### 專案目錄結構

```text
.
├── .agents/plugins/marketplace.json               # 本機外掛市集宣告（codex-workflow-local）
├── .gitignore                                     # Git 忽略規則
├── LICENSE                                        # MIT 開源授權條款
├── preview-zh.html                                # 獨立瀏覽器互動預覽版（免安裝可檢視三種情境）
├── README.md                                      # 專案總覽、安裝指南與多模型子代理自動配置規格
└── plugins/codex-workflow-monitor/
    ├── plugin.json                                # 外掛中繼宣告（v0.3.3）
    ├── mcp.json                                   # 使用 ${PLUGIN_ROOT} 的本機 stdio MCP 伺服器設定
    ├── package.json                               # 建置（esbuild）、語法檢查與驗證測試腳本
    ├── hooks/
    │   ├── hooks.json                             # 選用事件 Hook 宣告（14 類非同步事件）
    │   └── record_event.py                        # 僅記錄安全中繼資料的 Python Hook 腳本
    ├── server/
    │   ├── index.mjs                              # MCP 伺服器入口與 UI 資源封裝
    │   └── telemetry.mjs                          # 唯讀本機遙測引擎（SQLite + rollout 尾端 + Hook 合併）
    ├── public/
    │   └── monitor-zh.html                        # 繁體中文 TUI 數據流側邊分頁介面
    ├── src/bridge.mjs                             # UI 與 MCP App 宿主握手及輪詢橋接原始碼
    ├── dist/bridge.js                             # esbuild 編譯壓縮後的橋接腳本（npm run build 產生）
    └── test/verify.mjs                            # 自動化測試（HTML/JS 語法、單/多代理邏輯、stdio MCP 端到端）
```

### 外掛註冊的 MCP 工具與資源

| 項目 | 類型 | 存取屬性 | 說明 |
| :--- | :--- | :--- | :--- |
| `ui://codex-workflow/monitor.html` | App Resource | 唯讀 | 提供內嵌 `dist/bridge.js` 的側邊分頁互動 UI |
| `open_workflow_monitor` | App Tool | 唯讀 | 開啟側邊分頁（`thread` / `global`），回傳初始即時快照；支援 `session_id` 與 `scope`（`session` / `turn`） |
| `read_workflow_events` | Tool | 唯讀 | 讀取指定或自動追蹤工作階段的即時模型、能力模組、子代理與安全事件中繼資料 |
| `clear_workflow_events` | Tool | 寫入（僅限自管紀錄） | 僅清空 `~/.codex-workflow-monitor/events.jsonl`，不觸碰任何 Codex 原生資料庫 |

---

## 隱私、安全與隔離邊界

### 監控外掛的隱私邊界
- **嚴格唯讀中繼資料**：僅對 `$CODEX_HOME` 下的狀態資料庫（`state_*.sqlite`、`thread_history_*.sqlite`）與活躍執行緒的 `rollout-*.jsonl` 尾端讀取**結構化中繼資料**（模型名稱、推理強度、回合狀態、時間戳、工具類別與數值統計）。
- **不讀取也不回傳敏感本文**：不讀取、不記錄、不輸出對話提示詞、AI 回覆內文、工具輸入參數、工具輸出內容、API 金鑰或登入憑證。
- **不改動 Codex 原生檔案**：外掛運行期間絕不寫入或修改任何 Codex 資料庫或設定檔；`clear_workflow_events` 僅清空外掛自身位於 `~/.codex-workflow-monitor/events.jsonl` 的選用 Hook 紀錄。

### 多模型子代理的權限與隔離邊界
- **角色提示不等於系統隔離**：子代理繼承主會話的沙盒（Sandbox）、核准政策（Approval Policy）與 `mcp_servers`（Codex 官方規格明訂 `agents/*.toml` 無法覆蓋這些父層設定）；`explorer` / `audit` / `advisor` 的「唯讀」屬於行為約束與工具表面收斂，**並非獨立唯讀沙盒**。
- **`audit` 不自動等於 Git Worktree**：子代理預設與主會話共享工作樹，僅執行不修改來源檔的 diff 審查、無副作用測試與視覺檢查。若需強隔離，須由使用者許可後明確使用可控的 Git Worktree（或 `codex --worktree`），並確認審查環境包含要檢驗的實際未提交修改。
- **不納入 JEV／第三方代理路由器**：這套配置完全建構於 Codex 原生 Subagents、Custom Agents 與原生 `PreToolUse` Hooks 機制之上，不修改網路 Proxy、API Base URL、模型提供商、認證或網路攔截設定。

---

## Codex 多模型子代理自動配置完整規格

> **說明**：以下章節是供 Codex 直接執行的標準配置規格與模板（原《Codex 多模型子代理：自動配置說明書》整合修訂版 v2.0）。閱讀本節本身不會修改任何本機設定；適用範圍為個人全域配置（預設 `~/.codex/`，若環境變數已設定 `CODEX_HOME` 則以該目錄為準）。

### 0. 給 Codex 的執行指令與不可違反限制

**如果你是被要求配置自身環境的 Codex，請從這裡開始完整遵守以下規則。**

目標是在現有本機全域設定上，以增量、不破壞既有環境的方式導入上表所述的四模型多子代理分工（`Sol` `high` / `explorer` `medium` / `audit` `high` / `advisor` `xhigh`，並行上限 `3`，並加上 `PreToolUse` 防跨模型誤 Fork Hook）。未涵蓋的細節可依官方現行規範合理判斷並於預覽報告說明。

#### 不可違反的 10 項限制

1. **首次執行嚴格唯讀**：Phase A 只做唯讀盤點、模型核實、準備變更方案與完整 Unified Diff，**禁止寫入任何檔案**。收到使用者明確回覆「繼續／套用／批准」後，才可進入 Phase B（同樣適用於升級、安裝或替換模型）。
2. **嚴格限定修改範圍**：只修改個人全域 `$CODEX_HOME` 下的 `config.toml`、`AGENTS.md`、`agents/*.toml`、`hooks.json` 與 `hooks/guard_subagent_fork.mjs`；不得改動任何專案原始碼、Git 分支、依賴、測試或 CI。
3. **禁止暴力覆寫既有設定**：先盤點既有 `config.toml`、`AGENTS.md`、`agents/*.toml` 與 `hooks.json`；不得刪除既有其他代理、MCP、外掛、核准政策或沙盒設定。若既有主模型／推理設定衝突，或存在舊版 `search.toml`/`grep.toml`，必須於 Phase A 明確列出衝突與備份遷移選項待批。
4. **保持 TOML / JSON 結構與註解完整**：原地編輯時不得產生重複鍵、重複表格，或將頂層鍵誤寫進 `[agents]` 表內。寫入前必須備份，寫入後必須驗證。
5. **不捏造也不默默降級模型**：若指定模型或設定鍵不被當前客戶端支援，不得編造替代 ID、不得靜默降級、不得假稱成功；須於預覽報告提出可用替代方案待批。
6. **維持現行安全權限**：全程使用現有沙盒與核准政策，不使用 `--yolo`、`danger-full-access`，不提升權限，不安裝 JEV／Proxy，不要求或輸出登入憑證。
7. **如實說明隔離能力**：不得宣稱子代理自動擁有獨立唯讀沙盒或獨立 Git Worktree；新增或修改 `hooks.json` 後必須提醒使用者於新會話以 `/hooks` 核准信任雜湊。
8. **失敗即回滾**：未經批准不做額外清理；Phase B 任何一步失敗時，立即從備份恢復本次改動並回報原因。
9. **避免過度委派**：單次 `rg`、`git status`、簡單讀檔、單次 `codegraph_explore` 或小改動由主代理直接執行，不把所有命令都委派給子代理。
10. **受限環境誠實回報**：若執行環境無法寫入本機設定（例如雲端工作階段），應明確說明限制並輸出可供手動套用的檔案內容，不得宣稱已完成本機配置。

---

### 1. Preflight 唯讀檢查（不得寫入）

依序執行以下檢查：

1. 確認作業系統、Codex 執行環境與 `CODEX_HOME` 路徑（預設 `~/.codex`）。
2. 若 CLI 可用，執行唯讀指令檢查版本、Feature Flags 與模型目錄（命令不存在時不得猜測輸出）：
   ```sh
   codex --version
   codex features list
   codex doctor
   codex debug models
   ```
3. 唯讀檢查（若存在）：`$CODEX_HOME/config.toml`、`$CODEX_HOME/AGENTS.md`、`$CODEX_HOME/hooks.json`、`$CODEX_HOME/agents/*.toml`，盤點既有同名代理、舊版 `search.toml`/`grep.toml` 與既有 Hook，確認現有 TOML/JSON 可正確解析，並檢查是否存在更高優先權的專案設定或管理政策。
4. **核實模型與推理強度可用性**：透過 `codex debug models` 或唯讀檢視 `$CODEX_HOME/models_cache.json`，確認 `gpt-6.2-sol`、`gpt-6-luna`、`gpt-6.1-terra`、`gpt-6.2-astra` 的 `slug` 是否存在，以及各模型的 `supported_reasoning_levels` 是否支援對應等級（`high` / `medium` / `high` / `xhigh`）。因實際呼叫仍受帳號訂閱等級約束，若當下無法實測呼叫，須標註「快取已核實／實際會話待核實」。
5. 產生完整 **Unified Diff**（新檔案舊版為 `/dev/null`），列出預計新增／修改／歸檔備份／保留不動的檔案、衝突與處理選項、驗證方式及一鍵回復方法，然後**停止等待使用者批准**。

---

### 2. 寫入目標與設定檔模板

預設寫入個人全域 `$CODEX_HOME`（不寫入個別專案目錄；若已有同名代理或舊版 `search.toml`/`grep.toml`，於 Phase A 提出備份歸檔與替換方案，不直接刪除）：

```text
$CODEX_HOME/                     # 預設 ~/.codex
├── config.toml                  # 僅合併目標鍵，保留其餘既有設定與註解
├── AGENTS.md                    # 僅新增／更新專用 HTML 標記區段
├── hooks.json                   # 註冊 PreToolUse 防跨模型誤 Fork Hook（合併既有 Hook）
├── hooks/
│   └── guard_subagent_fork.mjs  # 攔截未指定 fork_turns="none" 的跨模型 spawn_agent
└── agents/
    ├── explorer.toml            # 覆寫內建 explorer（合併原 search + grep）
    ├── audit.toml               # Terra 獨立審查、測試與視覺驗收
    └── advisor.toml             # Astra 高階架構與根因顧問
```

#### 2.1 `config.toml` 目標值與相容性說明

合併以下**頂層鍵**與 `[agents]` 表（若 `[agents]` 或同名鍵已存在，就地更新，勿產生重複表格或重複鍵）：

```toml
# 主要會話：Sol
model = "gpt-6.2-sol"
model_reasoning_effort = "high"

[agents]
max_concurrent_threads_per_session = 3
default_subagent_model = "gpt-6-luna"
default_subagent_reasoning_effort = "medium"
```

- **為何將 Sol 預設設為 `high`、Luna 設為 `medium`**：主代理整場對話持續輪詢與重讀上下文，改為 `high` 可顯著省額度（遇超大型複雜設計再手動升 `xhigh`，且避免單一會話內頻繁切換 effort 打掉緩存）；Luna 負責檢索與呼叫鏈追蹤，`medium` 兼顧速度與成本。
- **為何省略 `[agents].enabled = true`**：在 `codex-cli 0.170.0+` 中 `agents.enabled` 預設已為 `true`；但在 `0.162.x` 中，`[agents]` 下的未知鍵會被當成自訂角色子表（`AgentRoleToml`），寫入 `enabled = true` 反而觸發 `Ignoring malformed agent role definition` 警告。省略此鍵可同時相容新舊版本。
- `max_concurrent_threads_per_session = 3` 表示同時最多開啟 3 個子代理執行緒（不含主代理，總槽位為 4），日常仍以同時 1～2 個為原則。
- 各 `agents/*.toml` 內的 `model` 與 `model_reasoning_effort` 會覆蓋 `default_subagent_*`；預設值僅套用於未指定模型的臨時匿名子代理。
- 僅當現有 `[features]` 顯式將 `multi_agent = false` 時，才提出最小化改動設為 `true`；若未設定或已為 `true`，不增添多餘鍵。
- 不修改既有 `sandbox_mode`、`approval_policy`、`model_provider`、`mcp_servers`、`plugins`、`marketplaces` 等設定。

#### 2.2 三份子代理定義檔（`agents/*.toml`）

> **Prompt 瘦身說明：** 三份子代理均設定 `features.apps = false`、`features.plugins = false`、`features.memories = false`、`skills.include_instructions = false`、`skills.bundled.enabled = false`。在 `codex-cli 0.170.0` 實測可通過 `--strict-config doctor` 並將每次子代理固定前綴縮減 **~23.7%**（~92K → ~70K 字元），且**不影響 `exec`、`view_image` 與 `config.toml` 中的 `mcp_servers`**（如 `codegraph`、`playwright`、`chrome-devtools`、`screenshot-server`）。若 `audit` 需要呼叫 Codex 內建 `browser`/`unified-computer-use` 外掛（`mcp__cua_repl`），僅需將 `audit.toml` 內的 `plugins` 改回 `true` 即可。

<details>
<summary><strong>展開檢視：<code>agents/explorer.toml</code>（Luna Explorer · 覆寫內建 explorer，合併探索與呼叫鏈）</strong></summary>

```toml
name = "explorer"
description = "Low-cost, read-only codebase explorer (Luna Explorer): locate relevant files, modules, symbol definitions, references, call chains, and data flow. Do NOT use for single-file reads, single rg/codegraph_explore queries, or code editing. Always invoke with fork_turns=\"none\" and a scoped question."
model = "gpt-6-luna"
model_reasoning_effort = "medium"
nickname_candidates = ["Luna Explorer"]

developer_instructions = """
你是唯讀程式碼探索與呼叫鏈追蹤子代理（Luna Explorer），同時負責廣度定位與精準符號分析。
職責範圍：快速定位與任務直接相關的檔案、模組入口、符號定義、引用、呼叫端、被呼叫端、資料流與測試位置。
工具與預算策略：
- 若工作區存在 `.codegraph/`，優先使用 `codegraph explore`（或 `codegraph_explore`）一次取得關鍵符號與呼叫路徑，再視需要補用 `rg --files`、`rg`、精準檔案讀取或唯讀 `git` 指令。
- 嚴格控制檢索預算：最多執行 10～15 次讀取／搜尋，足以回答主代理問題即收斂回報；禁止盲目掃描整個 repository 或傾倒大量原始碼。
- 遇到生成檔、快取目錄、建置產物或第三方程式碼應明確註明並跳過噪音。
硬性邊界：
- 嚴格唯讀：禁止修改任何程式碼、測試、文件或設定檔，禁止執行具副作用或改變工作樹的命令。
- 單層委派：禁止呼叫 `spawn_agent` 或聯絡其他兄弟代理，只向 `/root` 回報。
- 若搜尋範圍極小且主代理單次指令即可完成，回報結果後提醒無需續派子代理。
輸出契約（精簡、可直接供主代理決策）：
1. 定位結果：`path:line`、符號與職責摘要
2. 呼叫／依賴鏈：入口 → 中繼處理 → 呼叫端／資料流
3. 關鍵證據：僅附必要行號與精簡短片段（每段 ≤15 行，禁止貼整檔）
4. 未確認／排除項：嚴格區分實際確認與推測
"""

[features]
apps = false
plugins = false
memories = false
request_permissions_tool = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false
```

</details>

<details>
<summary><strong>展開檢視：<code>agents/audit.toml</code>（Terra Audit · 獨立審查、測試與視覺驗收）</strong></summary>

```toml
name = "audit"
description = "Independent verification & QA auditor (Terra Audit): inspect git diffs, run scoped safe tests, check regressions/security, and perform UI/screenshot/browser visual verification when provided. Do NOT use for repo-wide exploration or code edits. Always invoke with fork_turns=\"none\" and explicit changed files/commands."
model = "gpt-6.1-terra"
model_reasoning_effort = "high"
nickname_candidates = ["Terra Audit"]

developer_instructions = """
你是獨立品質驗證與審查子代理（Terra Audit）；預設嚴格不修改任何來源檔案或測試。
雙軌審查範圍：
1. 程式碼與測試面：針對主代理指定的變更檔案、`git diff` 與直接受影響的呼叫端，檢查變更溢位、邊界／空值／錯誤處理、向後相容、資安與憑證洩漏、回歸風險與測試覆蓋。
2. 視覺與互動面（適用時）：當主代理提供截圖路徑、前端預覽檔或本機 URL 時，善用視覺理解能力檢查排版裁切、文字溢出、對比度、狀態切換（發光／熄滅／空態）與互動異常。
工具與範圍約束：
- 嚴格收斂範圍：只審閱主代理指定的變更檔案、diff 與直接呼叫端，禁止全專案漫遊探索；若需大範圍追蹤引用，退回主代理改派 `explorer` 補查。
- 僅執行主代理准許且無破壞性的範圍測試（禁止擅自跑重型全套建置、執行破壞性清理命令，或透過修改原始碼／測試讓結果假通過）；如測試會產生快取或產物須先註明，且測試／截圖結束後確認共享工作樹未留下未預期的追蹤檔改動或殘留暫存檔。
- 單層委派：禁止呼叫 `spawn_agent` 或聯絡其他兄弟代理，只向 `/root` 回報。
- 沒有獨立 Git Worktree 時不得聲稱已在隔離環境執行；若發現牽涉深層架構設計、複雜演算法或跨模組系統性風險，明確建議升級由 `advisor`（Astra）複審。
輸出契約（嚴格區分 `PASS` / `FAIL` / `NOT_RUN`，不得將未執行測試寫成通過）：
1. 驗收判定：`PASS`（無 `P0/P1` 且必要測試全 `PASS`；僅有 `P2` 建議仍為 `PASS`）／`FAIL`（任一 `P0/P1` 缺陷或必要測試 `FAIL`）／`NEEDS_ADVISOR`（涉深層架構、演算法或跨模組設計風險）
2. 發現清單（依嚴重度 `P0 阻斷` / `P1 必修` / `P2 建議` 排序）：每項必含「嚴重度｜檔案:行號（或畫面位置）｜重現條件｜實測證據｜建議修法」
3. 測試矩陣：`指令｜結果 (PASS/FAIL/NOT_RUN)｜關鍵輸出摘要`
4. 未覆蓋與殘餘風險（若屬前端變更卻未附截圖／URL，亦在此標明）
"""

[features]
apps = false
plugins = false
memories = false
request_permissions_tool = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false
```

</details>

<details>
<summary><strong>展開檢視：<code>agents/advisor.toml</code>（Astra Advisor · 高階架構與根因終審顧問）</strong></summary>

```toml
name = "advisor"
description = "High-stakes architecture & root-cause advisor (Astra Advisor): consult ONLY before locking high-impact architecture, after 2 failed fixes on the same root cause, or before major final delivery. Do NOT use for everyday coding, small edits, or initial exploration. Always invoke with fork_turns=\"none\" and a self-contained evidence brief."
model = "gpt-6.2-astra"
model_reasoning_effort = "xhigh"
nickname_candidates = ["Astra Advisor"]

developer_instructions = """
你是高階技術顧問（Astra Advisor），只負責重大架構決策把關、深層根因診斷與重要交付終審；不負責日常實作，絕不修改工作目錄檔案。
證據優先與工具上限：
- 直接根據主代理提供的需求摘要、diff、錯誤日誌、測試紀錄與待決問題作判斷。
- 若主代理缺少關鍵證據（例如未附 diff、關鍵行號、重現輸出或已嘗試解法），第一步即直接回傳 `REVISE` 並條列缺少哪 1～3 項證據退回主代理，禁止自行啟動多輪 `exec` 或大範圍掃碼補查。
- 僅在存在阻斷性疑點時，最多執行 1～2 次精準唯讀補讀確認關鍵行號或介面契約。
- 單層委派：禁止呼叫 `spawn_agent` 或聯絡其他兄弟代理，只向 `/root` 回報。
審查重心：優先找出阻斷性架構風險、錯誤前提、介面／資料模型衝突、併發與狀態競態、資安邊界漏洞、測試缺口與長期維護成本；不重做主代理已完成的瑣碎工作。每個 `P0/P1` 必改項都必須對應具體失敗場景，禁止要求超出當前需求範圍的抽象重構或過度設計。
硬性邊界：絕不自行編輯檔案；對缺少證據的部分標記未確認，不得宣稱已執行測試或核准不可見的修改；最終採納與實作由主代理負責。
輸出契約（精簡可操作，嚴格控制篇幅）：
1. 判定：`APPROVE`（無 `P0/P1`，僅餘可接受之 `P2` 建議）／`REVISE`（方向可行但有 `P1` 必修缺口或證據不足）／`BLOCK`（存在 `P0` 資料毀損、資安漏洞、不可逆破壞或核心前提錯誤）
2. 核心依據（最多 3 點，直指關鍵因果）
3. 必改清單（依 `P0 阻斷` / `P1 必修` / `P2 建議` 排序，每項附具體可執行改法）
4. 殘餘風險與待人工確認事項
"""

[features]
apps = false
plugins = false
memories = false
request_permissions_tool = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false
```

</details>

#### 2.3 防跨模型誤 Fork `PreToolUse` Hook（`$CODEX_HOME/hooks.json` 與 `hooks/guard_subagent_fork.mjs`）

在 Codex MultiAgent V2 中，`spawn_agent` 預設 `fork_turns="all"`；跨模型子代理若未顯式帶 `fork_turns="none"`，會將主會話歷史整包複製進異質模型，造成跨模型 Prompt Cache 完全失效（甚至撐爆 Astra/Luna 的 272K 視窗）。透過本機同步 `PreToolUse` Hook 可在執行前直接 `deny` 違規派發，迫使主代理補上精簡自包含簡報後改帶 `fork_turns="none"` 重叫。

> **重要提醒：** 依 Codex 官方 Hooks 機制，新增或修改 `$CODEX_HOME/hooks.json` 後，須在新開的 Codex 會話中執行 `/hooks` 核准信任雜湊，Hook 才會正式生效。若 `$CODEX_HOME/hooks.json` 原有其他 Hook，請採合併方式加入，勿覆蓋既有項目。

<details>
<summary><strong>展開檢視：<code>$CODEX_HOME/hooks.json</code>（請將 Windows 路徑替換為實際 <code>$CODEX_HOME</code>）</strong></summary>

```json
{
  "description": "Codex multi-agent safety hooks: block accidental cross-model full-history forks on spawn_agent.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*spawn_agent$|^Agent$",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.codex/hooks/guard_subagent_fork.mjs\"",
            "commandWindows": "node \"%USERPROFILE%\\.codex\\hooks\\guard_subagent_fork.mjs\"",
            "timeout": 5,
            "statusMessage": "Checking subagent fork_turns policy",
            "async": false
          }
        ]
      }
    ]
  }
}
```

*(註：Windows 若需避免環境變數展開差異，於 Phase B 寫入實際本機時應解析為真實絕對路徑，例如 `node "C:\\Users\\<User>\\.codex\\hooks\\guard_subagent_fork.mjs"`。)*

</details>

<details>
<summary><strong>展開檢視：<code>$CODEX_HOME/hooks/guard_subagent_fork.mjs</code></strong></summary>

```javascript
#!/usr/bin/env node
import fs from 'node:fs';

const CROSS_MODEL_ROLES = new Set(['explorer', 'search', 'grep', 'audit', 'advisor']);
const DEFAULT_SUBAGENT_MODEL = 'gpt-6-luna';

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  const raw = readStdin().trim();
  if (!raw) process.exit(0);
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const toolName = String(payload?.tool_name || '').trim();
  if (!/(?:^|[:._/]|^)spawn_agent$/i.test(toolName) && !/^Agent$/i.test(toolName) && !toolName.toLowerCase().endsWith('spawn_agent')) {
    process.exit(0);
  }

  const input = (payload?.tool_input && typeof payload.tool_input === 'object') ? payload.tool_input : {};
  const agentType = String(input.agent_type || '').trim().toLowerCase();
  const requestedModel = String(input.model || '').trim().toLowerCase();
  const parentModel = String(payload?.model || '').trim().toLowerCase();

  let isCrossModel = false;
  if (CROSS_MODEL_ROLES.has(agentType)) {
    isCrossModel = true;
  } else if (requestedModel && parentModel && requestedModel !== parentModel) {
    isCrossModel = true;
  } else if (!requestedModel) {
    if (!parentModel || parentModel !== DEFAULT_SUBAGENT_MODEL) {
      isCrossModel = true;
    }
  }
  if (!isCrossModel) process.exit(0);

  const hasForkTurns = Object.prototype.hasOwnProperty.call(input, 'fork_turns') && input.fork_turns !== null && input.fork_turns !== undefined && String(input.fork_turns).trim() !== '';
  const forkTurnsVal = hasForkTurns ? String(input.fork_turns).trim().toLowerCase() : 'all';
  const v1ForkTrue = input.fork_context === true;

  if (forkTurnsVal !== 'none' || v1ForkTrue) {
    const roleHint = agentType ? `agent_type="${agentType}"` : `default_subagent_model="${DEFAULT_SUBAGENT_MODEL}"`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `已攔截跨模型全歷史 Fork（${roleHint}，目前 fork_turns=${hasForkTurns ? `"${forkTurnsVal}"` : '未指定(預設 "all")'}）。` +
          `請改帶 fork_turns="none"，並在 message 內提供精簡自包含簡報（目標、相關檔案路徑／行號、必要 diff 或錯誤日誌與明確待決問題）後重新呼叫 spawn_agent。`,
      },
    }) + '\n');
  }
  process.exit(0);
}

main();
```

</details>

---

### 3. 全域 `AGENTS.md` 協作規範

若 `$CODEX_HOME/AGENTS.md` 已存在，保留原文並在末尾附加以下標記區塊；若標記已存在，僅更新兩個 HTML 註解標記之間的內容（不可出現兩份，且不可把本 README 其他章節寫進 `AGENTS.md`）。若與既有規則衝突，須先於 Phase A 提出。

<details>
<summary><strong>展開檢視：寫入 <code>$CODEX_HOME/AGENTS.md</code> 的標記區段</strong></summary>

```markdown
<!-- BEGIN: CODEX MULTI-AGENT GLOBAL RULES -->

## Codex 多模型協作規則

### 角色配置（並行上限 `max_concurrent_threads_per_session = 3`）
- 主代理為 `gpt-6.2-sol`（`high`；遇超大型複雜任務再依需求手動升 `xhigh`，避免單一長會話內頻繁切換推理強度打掉緩存）：負責需求理解、方案整合、程式實作、變更所有權與最終回報（若使用者當前會話顯式選用其他主模型，以當前會話設定為準）。
- `explorer`（`gpt-6-luna` / `medium`，覆寫內建 `explorer`）：負責廣度探索、檔案定位、符號定義、引用與呼叫鏈分析（合併原 `search`/`grep`）。
- `audit`（`gpt-6.1-terra` / `high`）：負責獨立 diff 審查、範圍安全測試、回歸與資安檢查，以及在提供截圖／本機頁面時執行 UI／視覺驗收。
- `advisor`（`gpt-6.2-astra` / `xhigh`）：高階顧問，僅在重大架構鎖定前、同一根因連續失敗兩次、深層邏輯／系統風險或重要交付終審時諮詢。
- 除非使用者明確要求多代理並行改檔，**禁止呼叫內建 `worker` 角色**；若自訂代理或指定模型在目前環境不可用，先如實回報限制，不得假冒已呼叫。

### 委派判斷與 `spawn_agent` 硬性規範
1. **跨模型派發一律顯式帶 `fork_turns="none"`**：禁止省略 `fork_turns` 或使用 `"all"` 將主會話歷史整包複製進異質模型（會導致跨模型緩存失效與超出 Astra/Luna 272K 上下文視窗）；本機亦配有 `PreToolUse` Hook 硬攔截違規呼叫。改由 `message` 傳遞精簡自包含簡報。
2. **控制並行與冷啟動成本**：先評估任務大小、依賴關係與並行效益；同時啟用的子代理以 1～2 個為原則（上限 3），避免多執行緒重複讀檔。
3. **小查詢主代理直做**：單次 `rg`、讀檔、`git status`、簡單修正，或在已建 `.codegraph/` 索引的專案中單次 `codegraph_explore` 即可解答的問題，由主代理直接完成；**禁止為了保持上下文乾淨而把微小工具呼叫外包給子代理**。
4. **正確分流與單層委派**：大範圍探索與呼叫鏈追蹤只派 `explorer`（`gpt-6-luna`）；**禁止把全專案探索交給 `audit` 或 `advisor`**。所有子代理僅做單層委派（`max_depth = 1`），禁止互相聯絡或再衍生子代理。
5. **禁止無謂喚醒與密輪詢**：不要用 `followup_task` 喚醒已結束的子代理只為催進度或回覆「收到」；等待結果時 `wait_agent` 使用較長逾時（例如 60～180 秒）。避免續用舊對話遺留的非標準匿名子代理。
6. **寫入獨占與權限現實**：主代理獨占工作目錄的程式碼寫入；`explorer`、`audit`、`advisor` 均不直接修改來源檔案。子代理繼承父會話權限與沙盒，角色指令不構成系統級隔離，不得以文字承諾冒充實體隔離。

### 標準派發簡報契約（`message` 必填欄位）
- **派給 `explorer`**：明確問題、目標目錄／入口符號、排除目錄（如有）與期望回傳粒度。
- **派給 `audit`**：變更目標、修改檔案清單、`git diff` 範圍（或 commit 區間）、允許執行的範圍測試命令；涉及前端／畫面改動時附上截圖路徑或本機 URL 供視覺驗收。
- **派給 `advisor`**：精簡背景與限制（≤10 行）、關鍵檔案片段與行號、已驗證事實與失敗日誌、相關 diff，以及**單一明確待決問題**，讓顧問能直接判定而不必自行掃碼。

### Astra (`advisor`) 三個觸發時機與退場機制
1. **重大計畫鎖定前：** 僅在影響公共 API、資料模型、安全邊界、部署、跨模組架構或不可逆操作時才請 `advisor` 審核；一般功能開發或尚未釐清基本現況前**不得主動呼叫**。
2. **同一根因連續失敗兩次：** 收集重現步驟、兩輪嘗試紀錄、實際錯誤輸出與兩輪 diff 再請 `advisor` 診斷根因；僅錯誤文字相似不足以認定同一根因。
3. **重大工作宣告完成前：** 將整合 diff、驗收標準與實際測試證據交由 `advisor` 終審。小型低風險變更由主代理與 `audit` 驗收即可；若 `audit` 回報 `NEEDS_ADVISOR`（牽涉深層演算法或系統風險）則升級給 `advisor`。
- **迴圈退場**：`audit` 回 `FAIL` 時由 Sol 修正後僅針對修改處局部複核；`advisor` 回 `REVISE`／`BLOCK` 最多往返 2 輪，若仍存根本設計分歧直接回報使用者拍板。需求或程式碼隨後有重大變更時，舊簽核自動失效。

### 最終驗收與回報
- 子代理回傳屬證據與建議，主代理須核實其適用性並負最終責任。
- 回報依變更規模決定詳略：小型修正簡述變更與驗證即可；複雜或高風險任務列出修改檔案、重要決策、實際測試矩陣（嚴格區分 `PASS` / `FAIL` / `NOT_RUN`）、實際參與的子代理與未確認風險。不必逐一列出未啟動代理，嚴禁虛報已完成審查或測試。

<!-- END: CODEX MULTI-AGENT GLOBAL RULES -->
```

</details>

---

### 4. 分階段執行流程（Phase A-C）

#### Phase A — 唯讀調查與 Diff 預覽（第一次執行）
1. 完成第 1 節 Preflight（環境、CLI 版本、Feature Flags、既有設定與 Hook 盤點、模型目錄核實）。
2. 僅在記憶體中組裝候選設定，不寫入磁碟，輸出完整 **Unified Diff**。
3. 列出預計新增／修改／備份歸檔／不動的檔案、模型支援結果、主模型衝突選項、驗證步驟與還原方案。
4. **停止並等待使用者明確回覆「繼續」**；不可將閱讀文件當作批准。

#### Phase B — 寫入（取得明確批准後）
1. 確認目標檔案自 Phase A 後未被外部修改；若有異動，須重新產出 Diff 並再次請求批准。
2. 建立帶時間戳記的原始檔案備份目錄（含 `config.toml`、`AGENTS.md`、`hooks.json` 與全部既有 `agents/*.toml`），並於報告記下完整備份路徑。
3. 合併更新 `config.toml`、寫入 `agents/{explorer,audit,advisor}.toml`（若經批准合併舊版 `search.toml`/`grep.toml`，確認備份存在後再移除舊檔）、寫入 `hooks/guard_subagent_fork.mjs` 與合併 `hooks.json`，以及更新 `AGENTS.md` 的專用標記區塊。
4. 採原子或等價安全寫入；任一步驟失敗即從備份回滾，不留下半套設定。
5. 比對落盤檔案與批准 Diff，確認無多餘改動或反斜線轉義殘留。

#### Phase C — 驗證
1. 以標準 TOML／JSON 解析器檢查 `config.toml`、全部 `agents/*.toml` 與 `hooks.json`：無語法錯誤、無重複鍵／表，必填欄位（`name`、`description`、`developer_instructions`）齊全。
2. 執行 `codex --strict-config doctor` 與 `codex debug prompt-input`，確認 CLI 可無錯載入新配置、內建 `explorer` 已被 `Luna Explorer`（`gpt-6-luna` / `medium`）覆寫且無 `malformed agent role` 警告。
3. 單元測試 `hooks/guard_subagent_fork.mjs`：驗證省略 `fork_turns` 或 `"all"` 的跨模型 `spawn_agent` 回傳 `permissionDecision: "deny"`，`fork_turns: "none"` 與一般工具回傳空輸出放行。
4. 確認 `AGENTS.md` 僅含一組專用標記且保留原有規則。
5. 在**新開的 Codex 會話**執行 `/hooks` 核准新 Hook 信任雜湊，並以 `/status`、`/debug-config`、`/subagents` 確認配置生效（不可拿當前配置會話充當已生效證據）。
6. 視環境許可執行一次低風險唯讀派發測試（帶 `fork_turns="none"` 呼叫 `explorer`、`audit` 與簡短的 `advisor` 核實）；若無法直接派發，明確標註「配置、Hook 與 CLI 校驗已通過，實際派發待新會話驗證」，不可捏造執行紀錄。
7. 依第 5 節格式輸出完整報告與一鍵還原指令。

---

### 5. 驗收條件、反模式與交付報告格式

#### 驗收清單
- [ ] 套用於正確的 `$CODEX_HOME`，並已盤點既有設定、Hook 與 `models_cache.json`。
- [ ] 取得使用者明確批准前未進行任何寫入或安裝。
- [ ] 主代理與三個子代理（`explorer`、`audit`、`advisor`）模型與推理強度一致，無未核實或不存在的模型 ID，且內建 `explorer` 已由 `Luna Explorer` 覆寫。
- [ ] 所有 TOML 與 `hooks.json` 皆通過標準解析器與 `codex --strict-config doctor` 檢驗，無轉義殘留。
- [ ] `guard_subagent_fork.mjs` 通過攔截／放行單元測試，且已提醒使用者於新會話執行 `/hooks` 核准信任。
- [ ] 所有既有 MCP、外掛、沙盒、核准政策與全域規則完整保留。
- [ ] `AGENTS.md` 專用標記區塊僅存在一份。
- [ ] 明確回報備份位置與一鍵還原方式。

#### 明確禁止（反模式）
- 禁止省略 `fork_turns="none"` 對跨模型子代理進行全歷史 Fork（會擊毀緩存並撐爆 Astra/Luna 的 272K 視窗）。
- 禁止把每個微小查詢（或單次 `codegraph_explore` 可解的問題）委派給 `explorer`，或每次小修改都自動觸發 `advisor` 消耗額度。
- 禁止用 `followup_task` 喚醒已結束的子代理只為催進度或回覆「收到」。
- 禁止讓唯讀子代理在缺乏證據下作武斷結論、私自再呼叫 `spawn_agent`，或讓多個代理同時寫入同一份原始碼。
- 禁止由主代理口頭宣稱「已按顧問標準審核」冒充真正的 `advisor` 子代理回應。
- 禁止寫入未經核實的配置鍵（如舊版 `[agents]` 中的 `enabled = true`）或不存在的模型名稱（如 `gpt-6.2-terra`）。
- 禁止將 `AGENTS.md` 行為規範宣稱為真正的系統級 Sandbox 隔離。

<details>
<summary><strong>展開檢視：交付時 Codex 應輸出的標準報告格式</strong></summary>

```text
Codex 多模型子代理配置報告

階段：Phase A 預覽 / Phase B 已套用 / Phase C 已驗證
環境：作業系統、Codex 版本、CODEX_HOME
現況：原主模型、multi_agent 狀態、既有設定與 Hook 衝突與處理方式

變更清單：
- 新增：...
- 修改：...
- 備份歸檔：...
- 保留未變：...

變更 Diff：
（完整 Unified Diff；若過長請分段清楚呈現）

驗證：
- TOML / JSON 語法解析：PASS / FAIL / NOT_RUN
- CLI 嚴格配置檢查 (codex --strict-config doctor)：PASS / FAIL / NOT_RUN
- 內建 explorer 覆寫核實 (codex debug prompt-input)：PASS / FAIL / NOT_RUN
- 防 Fork Hook 單元測試 (guard_subagent_fork.mjs)：PASS / FAIL / NOT_RUN
- 模型目錄核實 (models_cache.json / debug models)：PASS / FAIL / NOT_RUN
- Sol 主代理 (gpt-6.2-sol / high)：PASS / FAIL / NOT_RUN
- Luna explorer (gpt-6-luna / medium)：PASS / FAIL / NOT_RUN
- Terra audit (gpt-6.1-terra / high)：PASS / FAIL / NOT_RUN
- Astra advisor (gpt-6.2-astra / xhigh)：PASS / FAIL / NOT_RUN

備份／還原命令：...
限制與待處理事項（含新會話執行 /hooks 核准信任）：...
下一步：等待批准 / 完成 / 需人工處理
```

</details>

---

## 版本更新摘要

- **`v0.3.3`（目前版本）**
  - 將面板與詳情抽屜中的「完成度」全面改為真實的**「緩存命中率（`cached_input_tokens / input_tokens`）」**（工具模組詳情標示為「成功率」），ASTRA 顧問刻度條亦改依緩存命中率比例點亮。
  - **RUNTIME Token 消耗改為 Agent + Subagent 總和**（依「對話／輪次」範圍同步統計），並於懸停提示與詳情抽屜提供主代理與子代理的拆帳明細與加權緩存命中率。
  - 強化遙測精準度與穩定性：新增 rollout 無損往回分塊掃描與 `thread_turns` byte-offset 區間定位（解決巨型輸出截尾、多子回合與 compaction 漏算）、`WITH RECURSIVE` 支援巢狀子代理、多 Advisor 實例彙總至 ASTRA 欄、消除執行中工具雙重計數與 `collaboration:*` 誤分類、修正 RUNTIME 即時跳秒與前端切換範圍輪詢競態。
- **`v0.3.2`**
  - 完成終端機 **TUI 數據流介面**重構：保留點陣框線、動態正交數據連線與光點動畫，並新增「對話（Session）／輪次（Turn）」統計範圍切換與「精簡隱藏」模式。
  - 統一文件與外掛／多子代理角色命名對照，移除本機絕對路徑並整理為 GitHub 公開發佈版本。
- **`v0.3.0`**
  - 修復「Codex Workflow 已逾時」問題：改用字面切片取代 `String.prototype.replace` 注入 `dist/bridge.js`，根除套件內 `` $` `` / `$&` 造成腳本截斷的錯誤，並加上 `--minify` 壓縮與強化握手流程。
  - 導入 Node 內建唯讀 `node:sqlite` 直接觀測 `$CODEX_HOME` 狀態資料庫與 `rollout-*.jsonl` 尾端中繼資料，實現單模型與多子代理皆免手動配 Hook 即開即用。
  - 實作三態發光邏輯與外掛自身輪詢過濾。

---

## 授權與作者

- **授權條款**：[MIT License](./LICENSE)
- **作者**：Baiming & GPT & Gemini

---

## 官方參考資料

> 若官方文件與本儲存庫規格有差異，請以本機 `codex` 執行檔實測及官方最新文件為準。

- Codex Subagents 與 Custom Agents：<https://learn.chatgpt.com/docs/agent-configuration/subagents>
- Codex Config Reference：<https://learn.chatgpt.com/docs/config-file/config-reference>
- Codex Config Basics：<https://learn.chatgpt.com/docs/config-file/config-basic>
- Codex CLI Reference：<https://learn.chatgpt.com/docs/cli/reference>
- Codex Developer Settings：<https://learn.chatgpt.com/docs/developer-settings>
- OpenAI Model Catalog：<https://developers.openai.com/api/docs/models>
