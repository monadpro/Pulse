# 同事 C 开发计划：真实钱包验收、演示前检查、安全说明、性质测试

**你的目标**：确保现场不出事故，并为评委的"靠谱吗"提供证据。你的产出是**测试报告、一个检查脚本、一份安全说明和几个新增测试**，只改自己的文件，**不会和负责人冲突**。

截止：**17:00 前**完成第一轮真实钱包验收，17:30 前交出其余初稿，18:15 前用线上版本复测，18:40 前跑通 `preflight`。

## 0. 开始之前（10 分钟）

```sh
git clone --recurse-submodules https://github.com/monadpro/Pulse.git && cd Pulse
git checkout dev
cd web && npm install && npm run dev        # 本地页面 http://localhost:5173
# 合约测试需要 Foundry：
brew install foundry && forge test          # 应显示 15 项通过
```

> 如果克隆时忘了 `--recurse-submodules`，补一句 `git submodule update --init`。

准备两个**测试专用**的 MetaMask 账户（不要用有真钱的），都从 https://faucet.monad.xyz 领一点 MON。

## 1. 真实 MetaMask 验收（优先级最高）

这是目前**最缺的一项**：钱包下单、清算、领取，以及新界面的组合，到现在都只有模拟钱包验证过。

### 做法
按 [`docs/TESTING.md`](TESTING.md) 的清单逐项执行，**用线上页面** https://monadpro.github.io/Pulse/ ，在以下环境各走一遍：

| 环境 | 说明 |
|---|---|
| 电脑 Chrome + MetaMask | 主要环境 |
| 手机（MetaMask 内置浏览器或手机 Chrome） | 至少走：连接、领币、下单、查看区块详情 |

### 额外要测的异常场景（清单里没有）
1. 在 MetaMask 里**拒绝签名**：页面应显示失败提示，不白屏、不卡死；
2. 钱包里 **MON 不够**时下单；
3. 钱包**切到别的网络**（比如以太坊主网）再点按钮：应提示或自动切回；
4. 装了**多个钱包**（比如 Coinbase Wallet）：下拉框能选，选 MetaMask 能正常用；
5. 下单后**刷新页面**：订单、历史还在；
6. **两个标签页**同时打开；
7. 点击**区块详情**、**订单详情**，对照 MonadVision 上的交易核对数字（订单数、清算价、成交数量）；
8. 自动清算脚本在运行时：下单后订单应在约 1 到 2 秒内变成"已领取"；点**攻击对比**两个按钮各一次，**确认一次**就应出结果。

### 产出：docs/TEST_REPORT.md

```markdown
## 第 1 轮（时间、环境、页面版本）
| 编号 | 测试项 | 结果 | 说明 / 截图 |
|---|---|---|---|
| 1 | 连接钱包 | ✅ | |
| 7 | 统一价 | ❌ | 现象……步骤……期望……实际…… |
```

问题分级：
- **P0**：下单失败、白屏、资金数额不对、无法领取 → **立刻直接告诉负责人**，不要等整理报告；
- **P1**：能用但明显误导或难用；
- **P2**：文案、样式、小瑕疵。

每个问题写清：**步骤、期望、实际、环境、截图**。负责人修复后，你在 18:15 前用线上版本**复测一轮**，更新结果。

## 2. web/scripts/preflight.ts：演示前一键检查（新建）

运行方式：`cd web && DEMO_WALLETS=0x...,0x... npx tsx scripts/preflight.ts`。**只读，不需要任何私钥**。可参考 `web/scripts/keeper.ts` 里创建 viem 客户端的写法，地址从 `web/src/deployments.json` 读取。

### 检查项与判定

| # | 检查 | 通过标准 | 失败时的提示 |
|---|---|---|---|
| 1 | 公共节点 HTTP | 链 ID 是 10143，区块号在 2 秒内增长 | 改用备用节点或专用密钥 |
| 2 | WebSocket | 5 秒内收到一个新区块 | 页面会退回 HTTP 轮询，演示仍可用 |
| 3 | 5 个合约 | `getCode` 都非空 | 地址不对或合约未部署 |
| 4 | 交易所可读 | `ordersLength`、`settledBatchCount`、`maxBatchOrders` 能读出 | — |
| 5 | **keeper 是否在清算** | `recentBatches(48)` 里，没有"早于链头 20 个区块仍未清算"的批次 | **keeper 可能停了**，告诉负责人 |
| 6 | 演示钱包 | `DEMO_WALLETS` 里每个地址：MON ≥ 0.2，pMON 和 pUSD ≥ 100，对交易所的授权额度 ≥ 1000 | 写清缺什么、怎么补（领币 / 授权） |
| 7 | keeper 钱包 | `KEEPER_ADDRESS` 的 MON ≥ 0.3 | 余额低，自动清算会停 |
| 8 | AttackLab 库存 | Lab 持有的 pMON、pUSD 各 ≥ 5,000 | 攻击对比会失败 |
| 9 | AMM 池子 | `quoteReserve / baseReserve` 在 0.9 到 1.2 之间 | 池子已偏移，演示数字会和文档不同（告诉负责人重置） |
| 10 | 线上页面 | `https://monadpro.github.io/Pulse/` 返回 200 且包含 "Pulse" | 页面无法访问 |

输出要求：每项一行 `✅ / ⚠️ / ❌ + 说明`，最后给总结；**有任何 ❌ 时进程退出码为 1**。

验收：在当前环境跑一次，应除 9（池子已被试用偏移）外基本通过；故意写一个错误的钱包地址，应看到 ❌ 和修复提示。

## 3. docs/SECURITY.md：威胁模型与已知限制（新建）

先读 `src/PulseExchange.sol` 和 `test/`，写下**你核实过的**内容，不要照抄我说的：

1. **资金如何流动**：下单托管、清算不动钱、领取结算；合约没有管理员和提现函数（请自己在代码里确认）。
2. **信任假设**：代币是标准 ERC20（无转账手续费、无回调）；清算任何人可调用且结果确定。
3. **逐项检查并记录结论**（有问题就如实写）：
   - 重入：领取时是否先改状态再转账；
   - 取整：买方多付、卖方少收的方向是否始终让合约不欠钱；
   - 溢出：同一档位买卖打包在一个存储位，`uint128` 加法溢出会怎样；
   - 拒绝服务：有没有无上限的循环（`ordersOf`、`claimMany`、`settleMany` 的输入长度）；
   - 价格档位和数量的边界（0、最大档位、1 wei）。
4. **已知限制**：测试币任何人可无限领；没有审计；价格只有 64 档；同区块订单写同一批档位，并行执行下会互相冲突；清算需要有人触发（目前靠 keeper）。
5. **静态分析**（有时间再做）：尝试安装并运行 Slither（`pip install slither-analyzer` 后 `slither .`），把输出里值得关注的几条和你的判断记下来。**工具没跑成就写没跑成，不要编造。**

## 4. 新增性质测试（只新增文件：test/PulseProperties.t.sol）

**不要修改已有测试文件**。参考 `test/PulseExchange.t.sol` 里的写法（搭建代币、交易所、预设账户和授权）。

### 4.1 订单顺序不变性（强烈推荐，这是项目的核心卖点）
> 同一批订单，无论以什么顺序提交，清算价、成交量和每个账户的成交结果都完全相同。

做法：用同一组订单（比如 20 笔，账户、方向、档位、数量由模糊测试生成），分别在**两个交易所实例**（或不同区块）里按"原顺序"和"打乱后的顺序"提交，清算后比较：
- `getBatch` 返回的清算档位和成交量相同；
- 每个账户的**总成交数量、总到账**相同（订单编号会不同，所以按账户汇总比较）。

通过了，就是"顺序不产生收益"的机器证明，可以直接写进 QA。**如果测出不一致，立刻告诉负责人，这是重要发现。**

### 4.2 其他（时间允许再做）
- `settleMany`、`claimMany` 幂等：重复调用不会重复支付；
- 边界：档位 0 和 63、数量 1 wei、数量为 0 应回退、`uint128` 溢出应回退；
- 记录清算 gas 随订单数（2、50、200、1000 笔）的变化，整理成表放进 `docs/SECURITY.md` 或 `TEST_REPORT.md`。

推送前运行 `forge fmt && forge test`，全部通过再推。

## 5. 稳定性事项（非代码，时间允许再做，写进 docs/OPS.md）

1. **专用 RPC 密钥**：申请 QuickNode 或 Alchemy 免费账号，拿到 Monad 测试网的 HTTP/WSS 地址，测试限流是否改善。**密钥不要提交到仓库**，只私下发给负责人。
2. **备用托管**：把 `web/` 构建后部署到 Vercel 或 Cloudflare Pages（构建命令 `cd web && npm install && npm run build`，输出目录 `web/dist`，基础路径用默认 `/`）。部署后用 MetaMask 试一次，记录是否仍弹"恶意网站"提示，把链接发给负责人。
3. **Blockaid 误报申诉**：到 https://report.blockaid.io/ 提交 `monadpro.github.io` 的误报申请，附上项目说明、已验证的合约地址、仓库链接。记录提交时间和回复。

## 6. 提交方式

直接推送到 `dev`，规则见 [COLLABORATION.md](COLLABORATION.md)：

```sh
git pull --rebase origin dev
git add docs/TEST_REPORT.md docs/SECURITY.md docs/OPS.md web/scripts/preflight.ts test/PulseProperties.t.sol
git commit -m "test: acceptance report / preflight / security notes"
git pull --rebase origin dev && git push origin dev
```

## 7. 时间表

| 时间 | 事项 |
|---|---|
| 现在 – 17:00 | 环境准备，第 1 轮真实钱包验收，**P0 问题随时通报**，TEST_REPORT.md 初稿 |
| 17:00 – 17:30 | `preflight.ts` 初稿；开始写顺序不变性测试 |
| 17:30 – 18:15 | `SECURITY.md`、性质测试；用线上版本**复测**，更新报告 |
| 18:15 – 18:40 | 跑 `preflight`，配合全员排练，记录排练中出现的问题 |
| 18:40 – 19:00 | 最终确认线上页面可访问、keeper 在运行、钱包余额充足 |

## 8. 不要做的事
- 不要改合约（`src/`）、`web/src/`、`web/src/deployments.json`、已有的测试文件；
- 不要提交 `.env`、私钥、RPC 密钥；
- 测试用账户不要用有真钱的钱包；
- 不要在报告里写没有亲自验证的"通过"。
