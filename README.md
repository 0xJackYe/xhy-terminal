# XHY Terminal

个人总终端：加密资产、比特币价格警报与快速出境，并提供 Windows CMD 界面。饮食日记已从网页移除，代码与日记数据仍保留在 `apps/diet/`，CMD 客户端仍可查看和修改。

## 代码结构

- 根目录及 `frontend/`：统一网页、深浅主题、北京/GMT/丹佛/新德里时钟、工作状态、服务代理及命令行终端。
- `apps/diet/`（网页中已不显示）：饮食日记、按日期查看、折叠餐食、DeepSeek 自然语言查询及修改。日记日期按 UTC+0 划分（北京时间 08:00 换日），跨北京时间零点的夜班记在同一天；时钟、警报时间和比特币当日涨跌仍用北京时间。已有记录的日期保持不变。
- `apps/bitcoin/`：欧易/币安只读账户查询、离线钱包、价格警报、定投成本和长期持仓浮盈。
- `cloud/`：Cloudflare Worker 云端终端（D1 数据、登录、定时同步、快速出境），部署与迁移见 `cloud/README.md`。
- `security_guard/`：本机安全卫士的命令行源码。
- `configs/api-credentials.json`：按仓库所有者明确要求，包含明文欧易、币安及 DeepSeek API 配置。仓库为私有。

## 当前持仓功能

只展示持仓平均买入价、当前 BTC/USDT 价格、浮盈和收益率。每笔定投按实际净到账 BTC 与含手续费支出自动更新移动加权平均成本；后台每 20 秒核算，页面每 30 秒刷新。历史卖出只调整剩余持仓成本。跨币种买入按成交分钟行情折算，计算假设在页面可展开查看。

- **比特币总持有**：欧易 BTC 净持有 + 币安 BTC + 离线钱包。币安计入现货、资金和理财钱包里的 BTC；杠杆、合约钱包可能含借入或保证金，只计入资产估值，不算作持有的 BTC。持仓浮盈和均价仍只按欧易成交账本与离线钱包核算（币安没有成本记录）。BTC 数量显示到 8 位小数（聪），完整数值在鼠标悬停提示里。
- **累计盈亏**（总览卡片与钱包页）：当前加密资产总市值 + 已提出 − 累计投入，即已实现与未实现盈亏之和，正数绿色、负数红色，旁边是相对累计投入的收益率；投入和提出取自已核对的出入金记录（云端），悬停可看到计算式。本机终端没有这份记录，显示“—”。
- **币安读取**：云端每分钟用只读 API 读取钱包余额（官方 `needBalanceDetail=true` 逐币明细）；若现货或资金钱包没有返回明细，再用这两个钱包各自的只读余额接口补齐。没有逐币明细的其他钱包按钱包合计计入。单个无法识别的条目只把所在钱包标为不完整，不再让整个币安读数失败；中文等无大小写文字的币种代码也能识别。币安读取失败时，钱包页“资产分布”里的“币安”会显示状态，悬停可看到原因（例如 IP 白名单或地区限制）。

## 钱包页（加密资产 → 钱包走势）

在总终端里显示为两栏：左边是比特币总持有（各来源一行）、盈亏（累计盈亏在前，BTC 浮盈、收益率、持仓均价、当前价格，下面是两个平均年化）、合计余额走势和攒到 1 BTC 进度；右边是资产分布和定投。重复的链上地址视图、正常状态下的欧易连接卡片、每行时间戳和说明文字在这里隐藏；数据过期时会重新显示快照时间。单独打开比特币终端（`/btc/`）仍显示全部明细。

## 本机运行

需要 Windows、Python 3.9+、Node.js 20+，比特币后台依赖见 `apps/bitcoin/requirements.txt`。

```powershell
python -m pip install -r apps/bitcoin/requirements.txt
python restore_api_credentials.py
$env:XHY_DIET_ROOT = Join-Path $PWD 'apps/diet'
$env:XHY_OPTIONS_ROOT = Join-Path $PWD 'apps/bitcoin'
python launch.py
```

总终端默认地址为 http://127.0.0.1:8780/；饮食和比特币后台分别使用 4173、8766。CMD 使用 `python cli.py`，或双击原有启动脚本。上述环境变量让启动器使用仓库内的两个子项目。

## 手机界面

打开页面时自动识别设备：手机（iPhone、Android 手机，或短边小于 600px 的触屏设备）显示手机界面，包括大标题、可横向滑动的时间条、底部悬浮标签栏和底部弹出的连接详情；电脑和 iPad 显示桌面界面。连接详情里的“界面”可切换为自动、手机或电脑，选择保存在当前浏览器；也可以在地址后加 `?ui=mobile`、`?ui=desktop` 或 `?ui=auto`。添加到 iPhone 主屏幕后以全屏方式打开。

## 时钟与工作状态

- 页头依次显示北京、GMT、丹佛、新德里时间；丹佛随美国夏令时自动在 UTC−6 和 UTC−7 之间切换，新德里固定为 UTC+5:30。鼠标悬停可看到各地日期和时差。
- 工作状态按北京时间 23:00–次日 07:00、周一至周五夜班计算：周五夜班延续到周六 07:00，周六、周日夜里显示“周末”，倒计时会跨过周末直接数到周一 23:00。不再区分冬令、夏令班次。
- CMD 客户端页头同样显示这四个时间和当前班次状态。

## 实时行情与快捷操作

- 总览页的比特币价格、当日涨跌、区间和走势末端随行情更新（本机每秒，云端约每 5 秒），卡片标题旁显示“实时”，浏览器标签页标题同步显示价格。数据流只含行情、警报设置和最近 8 条警报，不含整日走势（`/btc/api/terminal/events?view=market`）；离开总览或标签页隐藏 5 分钟后断开，回来自动重连。本机比特币终端自身的数据流在走势不变时只发送最新的点。
- 电脑上按 ⌘K / Ctrl+K（或 `/`、`?`）打开命令面板，可按中文、英文或拼音首字母搜索页面和操作；`1` `2` `3` 切换页面，`R` 刷新总览，`T` 切换明暗。焦点在嵌入的项目页面内时同样有效，输入文字时不触发。连接详情底部列出这些按键。
- 在本机打开时，若比特币终端未运行，总览顶部和对应页面显示“启动服务”按钮，一键在本机启动，恢复后页面自动重新加载。

## 云端终端

正式终端也运行在 Cloudflare Worker 上（需登录，不依赖电脑开机），见 `cloud/README.md`。本机和云端使用同一套 `frontend/`：

- 本机（127.0.0.1 / localhost）可从网页启动未运行的服务；云端由 Worker 提供全部接口，不显示“启动服务”。
- 快速出境的航班数据源和出行设置保存在云端数据库，只在云端终端中使用。
- 地址后加 `?demo` 显示标注为“演示数据”的示例数据，不读取任何账户，可用于预览界面。

## 数据单独恢复

这是源码和 API 配置备份。实际饮食日记、钱包快照、账户流水、成本账本、报警设置、日志及截图没有提交，原电脑上的数据没有修改。

- 饮食：从原项目恢复 `data/diary.json` 及需要的 `.local/runtime-diary.json`。新建空日记可复制 `apps/diet/data/diary.example.json` 为 `diary.json`。
- 比特币：从原项目恢复 `terminal/data/`，特别是 `bitcoin-balance-snapshot.json` 和 `bitcoin-cny-rates.json`；在 `apps/bitcoin/` 内运行 `node terminal/wallet/build_wallet.mjs` 重新生成余额页面。生成页含私人快照，因此不纳入 Git。
- DPAPI 受保护的账本与凭据绑定 Windows 用户。跨电脑时可用本仓库的明文 API 配置重新写入凭据，历史账本仍需按原导入流程恢复，不会伪造历史成本。
- 邮件凭据没有包含；如需邮件通知，在本机页面重新配置。

`restore_api_credentials.py` 只把本仓库的 API 配置导入仓库内比特币项目的本机加密存储；已有凭据不会覆盖，不调用交易或转账接口。

## 验证

```powershell
python -m unittest test_server test_cli -q
cd apps/bitcoin
python -m unittest test_btc_pnl_service test_btc_cost_tracker test_btc_cost_http test_btc_terminal_server test_combined_wallet_service -q
node test_terminal_frontend.js
node --test test_terminal_ui.js
node test_combined_wallet_ui.js
node test_annualized_wallet_ui.js
node test_crypto_portfolio_ui.js
node test_btc_cost_ui.js
python -m unittest test_binance_wallet test_crypto_portfolio_service -q
```

云端：`cd cloud && npm ci && npm test`（构建后运行 Worker、饮食和钱包界面测试）。

饮食项目可运行 `npm run check`、`npm test`、`npm run build`。部分原始日记归档检查需先恢复本机日记数据；日常测试不调用付费 AI 或交易接口。

原有 Diet 和 Portfolio 仓库未改动。此仓库保存的是三个本机项目当前代码的整合快照。
