# Pulse 开发计划

> 一个区块，一个价格。Monad 每 300ms 出一个块，Pulse 在每个块里做一次链上统一价清算。
> 状态：合约已完成并通过测试；部署脚本和前端脚手架已写入但**未验证**；其余待办见第 6 节。

## 1. 目标

在 19:00 提交截止前，做出一个**能现场跑起来**的链上逐块批量拍卖交易所，并在 3 分钟内讲清楚：

1. **新机制**：同一区块内所有订单按同一个清算价成交，下单顺序不产生收益，因此抢跑和三明治攻击拿不到利润。
2. **只有 Monad 跑得动**：300ms 出块让"每块一轮拍卖"的等待时间低于 1 秒，清算 gas 固定在 17 万左右，适合每块执行。
3. **和官方现有方案不重合**：扫描结果见 `../research/github-scan.md`。

## 2. 与已有项目的差异（答辩时要主动讲）

| 项目 | 做法 | Pulse 的区别 |
|---|---|---|
| 官方 spot-clob / workshop-clob / OddLane | 链上**连续撮合**订单簿，按挂单价成交 | Pulse 按块批量成交，**统一清算价** |
| 官方 typewriter | 链下服务器每 50ms 收一批订单，批内排序后连续撮合，依赖可信排序者 | Pulse **全部在链上**，按区块清算，**不需要信任排序者** |
| DarkBook / MEV Gladiator | ZK 暗池 / 仅可视化 | Pulse 用机制本身消除排序收益，不依赖 ZK |

关于名字：成都 V2 有一个跟单项目也叫 PULSE，领域完全不同。仓库已经叫 Pulse，保留，评委问到时说明即可。

## 3. 合约设计（已完成）

文件：`src/PulseExchange.sol`、`src/MockToken.sol`

- `submitOrder(side, tick, amount)`：托管资金，把数量累加进当前区块批次的某个价格档位（共 64 档，价格 0.50 到 1.13，步长 0.01）。
- `settle(batch)`：区块结束后任何人可调用。固定扫描 64 档，选出**成交量最大**的价格（并列时取最低价）。gas 固定约 17 万，不随订单数增长。
- `claim(orderId)`：按清算价领取成交部分，并退还多托管的资金。多出的一方按比例成交。
- 舍入方向始终对合约有利，合约不会欠超过持有的资金，已用模糊测试验证。
- 已知取舍：并列最大成交量时取最低价，对买方有利；不同档位的订单不做时间优先。

测试（`test/PulseExchange.t.sol`，7 项全部通过）：统一价、无交叉全额退款、按比例成交、三明治无利润、settle gas 与订单数无关、未结束批次不可清算、偿付能力模糊测试。

## 4. 前端设计（待完成）

技术栈：Vite + React + viem，文件在 `web/`。

**页面**

1. **顶部**：连接 MetaMask，自动添加和切换到 Monad 测试网；显示 pMON / pUSD 余额和 faucet 按钮。
2. **脉冲时间轴**（核心展示）：每个新区块一格，订阅 `monadNewHeads`，随 `commitState` 变色（Proposed 黄，Voted 蓝，Finalized 绿）；每格显示该批订单数和清算价。
3. **下单面板**：买/卖、价格档位、数量；显示"从点击到确认用了多少毫秒"。
4. **订单与结算**：当前账户的订单列表，已结束批次提供 Settle / Claim 按钮；后续做成自动 settle。
5. **攻击对比面板（P1）**：模拟恶意出块者在同一块内前置买入、后置卖出，对比 AMM 与 Pulse 的受害者损失。

**遵循 Monad 文档的实现细则**

- 链定义用 `defineChain` 自己写，不用 viem 内置的旧版 `monadTestnet`（已写在 `web/src/chain.ts`）。
- gas limit 写死，不调用 `eth_estimateGas`，因为 Monad 按 gas limit 全额收费（已写在 `web/src/abi.ts`，分别为 approve 7 万、faucet 9 万、submitOrder 24 万、settle 20 万、claim 17 万，均略高于实测值）。
- 实时数据用 WebSocket 订阅，不轮询 `eth_getLogs`。
- 注入式钱包（MetaMask）自己签名并发送，没法用 `eth_sendRawTransactionSync`，所以前端用 100ms 轮询 receipt 来测延迟；压测机器人持有私钥，可以用同步方法。
- nonce 在本地维护。
- 公共 RPC 限速 20–50 rps，前端查询要合并，压测时申请专用 key。

## 5. 部署与运维

1. 安装 Foundry（已装 1.8.5），`foundry.toml` 里设 `network = "monad"`（已完成）。
2. 用 keystore 导入部署钱包：`cast wallet import monad-deployer --interactive`。**私钥由你自己输入，我不接触。**
3. 从水龙头领测试币：`POST https://agents.devnads.com/v1/faucet`，请求体 `{chainId:10143,address}`。
4. 部署：`forge script script/Deploy.s.sol --rpc-url monad_testnet --account monad-deployer --broadcast`，脚本会把地址写入 `web/src/deployments.json`。
5. 在 MonadVision 验证合约（Sourcify，无需 API key）。

## 6. 任务清单

| # | 任务 | 状态 |
|---|---|---|
| 1 | 研究：GitHub 扫描、开发文档、安装 MONSKILLS | 完成 |
| 2 | 合约和测试 | 完成 |
| 3 | 部署脚本 `script/Deploy.s.sol` | 完成（已在本地 anvil 验证） |
| 4 | 前端脚手架（配置、链定义、ABI） | 完成 |
| 5 | 前端：钱包连接、faucet、下单面板 | 已写，类型检查和构建通过；**钱包交互未在浏览器实测**（需要 MetaMask） |
| 6 | 前端：脉冲时间轴和区块状态变色 | 完成（本地 anvil 实测黄、蓝、绿变色；`monadNewHeads` 需在测试网验证） |
| 7 | 前端：订单列表、Settle / Claim | 已写，未在浏览器实测 |
| 8 | 部署到测试网 | 完成，5 个合约均已在 MonadVision（Sourcify）验证，完全匹配 |
| 9 | 实测 `eth_sendRawTransactionSync` | 完成，公共 RPC 支持 |
| 13 | GitHub Pages 自动部署（https://monadpro.github.io/Pulse/） | 完成 |
| 10 | 压测机器人 `web/scripts/bot.ts`（单钱包并发发单、本地管理 nonce） | 完成（测试网实测 24 笔订单，单个区块最多 8 笔） |
| 11 | 攻击对比面板（模拟恶意出块者，AMM 对 Pulse） | 完成（合约在测试网实测：AMM 受害者少买 23.9%，攻击者赚 230.9；Pulse 攻击者利润 -1 wei） |
| 12 | README 完善、录制 3 分钟备份视频、提交到 Mojo | 待做 |

优先级：任务 5–9 是演示的最小闭环（P0）；11 是演示高光（P1）；10 视时间而定（P2）。

## 7. 时间安排（按 19:00 截止倒排）

| 阶段 | 内容 |
|---|---|
| 现在 – 15:00 | 任务 3–7：前端核心功能，本地对接合约 |
| 15:00 – 16:30 | 任务 8–9：部署测试网，实测同步发送和延迟 |
| 16:30 – 17:30 | 任务 11（攻击对比）；有余力做任务 10 |
| 17:30 – 18:15 | 联调、修 bug，录 3 分钟备份视频 |
| 18:15 – 19:00 | 完善 README，确认仓库公开，在 Mojo 提交 |

## 8. 风险与预案

| 风险 | 预案 |
|---|---|
| 水龙头领到的测试币不够 | 减少机器人数量，压测改成演示用的小规模 |
| `eth_sendRawTransactionSync` 在公共 RPC 不可用 | 退回 400ms 轮询 receipt |
| `monadNewHeads` 的返回结构与预期不符 | 退回普通 `newHeads`，按时间推算状态颜色，并在界面里注明 |
| 恶意出块者模拟被质疑"Monad 本来就没有全局 mempool" | 叙事改为：local mempool 限制谁能看到交易，Pulse 让顺序本身没有价值，两层互补 |
| 现场网络或演示出故障 | 播放预先录好的 3 分钟视频 |
| 时间不够 | 砍掉任务 10，攻击对比改为合约测试加终端输出 |

## 9. 验收标准

- `forge test` 全部通过。
- 合约已部署到 Monad 测试网并通过验证。
- 前端能完成：连接钱包、领币、下单、看到脉冲格变色、清算、领取。
- 演示脚本能在 3 分钟内跑完。
- GitHub 仓库公开，README 说明清楚，代码均为当天产出。

## 10. 演示脚本（3 分钟）

1. **0:00–0:20** 痛点：DEX 用户因抢跑和三明治攻击持续亏损。
2. **0:20–1:30** 现场下单，脉冲格逐块变色，订单按统一价成交，显示确认延迟。
3. **1:30–2:30** 攻击对比：同一攻击打 AMM，用户亏损；打 Pulse，攻击者无利润。
4. **2:30–3:00** 总结：为什么只有 Monad 能每块清算一次，以及和 typewriter 的区别。
