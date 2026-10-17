# 协作指南：dev 分支与分工

目标：3 个人并行开发，互不冲突，19:00 前稳定提交。

## 一、分支规则

| 分支 | 作用 | 谁能推送 |
|---|---|---|
| `main` | **线上版本**。推送后 GitHub Pages 会自动部署到 https://monadpro.github.io/Pulse/ ，评委看到的就是它 | 只有负责人，且只合并验证过的 `dev` |
| `dev` | **集成分支**。大家的功能先合到这里，一起测 | 通过合并请求（PR） |
| `feat/<名字>-<主题>` | 每个人的功能分支，例如 `feat/alice-hero` | 自己 |

流程：

```sh
git checkout dev && git pull
git checkout -b feat/<名字>-<主题>      # 从最新的 dev 开分支
# ……开发、测试……
git add <只加自己改的文件> && git commit -m "说明做了什么"
git pull --rebase origin dev            # 提交前先同步，有冲突当场解决
git push -u origin feat/<名字>-<主题>
# 在 GitHub 上开 PR：feat/... -> dev
```

规则：
1. **不要直接推 `main`，也尽量不直接推 `dev`**，用 PR。
2. 每个 PR 小而专一，提交前运行 `cd web && npm run build`，合约相关再运行 `forge test`。
3. **只改自己负责的文件**（见下表）。要改别人负责的文件，先在群里说一声。
4. **不要提交 `.env`、私钥、RPC 密钥。** `web/src/deployments.json` 只由负责人改。
5. **不要改合约。** 合约一改就要重新部署，所有人的订单和余额会清零，并且要重新验证。确实要改，先和负责人商量。
6. 新增依赖要先说，页面体积和部署都受影响。

## 二、文件归属（避免冲突）

| 文件或目录 | 归属 |
|---|---|
| `web/src/App.tsx`、`BlockDetail.tsx`、`OrderDetail.tsx`、`useBatches.ts`、`BatchLens.tsx`、`chainClients.ts`、`chain.ts` | **负责人** |
| `src/`（合约）、`script/`、`web/src/deployments.json`、`web/scripts/keeper.ts` | **负责人** |
| `web/src/AttackPanel.tsx` | 同事 A |
| `web/src/Hero.tsx`（新建）、`web/index.html` | 同事 A |
| `docs/DEMO.md`、`docs/QA.md`（新建）、`README.md` | 同事 B |
| `docs/SECURITY.md`（新建）、`test/`（只新增测试文件，不改已有的）、`web/scripts/preflight.ts`（新建） | 同事 C（可与 B 对调） |
| `web/src/style.css` | 共用：只在文件**末尾追加**，用自己的类名前缀，避免互相覆盖 |

## 三、建议的并行任务

### 同事 A：页面表达与视觉（只动自己的文件）
1. **首屏讲清"为什么需要 Pulse"**：新建 `Hero.tsx`，放一句问题陈述（同区块统一价，减少靠先后顺序赚差价的空间）、测试网和测试代币的提示、"三步试用"入口。完成后让负责人在 `App.tsx` 里加一行引用。
2. **攻击对比可视化**：在 `AttackPanel.tsx` 里把两个卡片的数字改成并排的条形对比（用纯 CSS 或手写 SVG，不引入图表库）。数据已经有：受害者本应买到、实际买到、攻击者利润。
3. 视觉细节：按钮层级、间距、移动端（追加到 `style.css` 末尾）。

### 同事 B：演示与提交材料（几乎不会冲突）
1. **`docs/DEMO.md`**：3 分钟演示的逐句稿、点击顺序、每一步在页面上的位置，以及现场前的检查清单（钱包余额、授权、keeper 是否在跑、页面能否打开、备用的本地页面）。
2. **`docs/QA.md`**：评委可能追问的问题和回答（Monad 特性用在哪、和 typewriter/CoW 的区别、安全性、局限性、为什么不会被抢跑）。素材在 `docs/ATTACK_COMPARISON.md` 和 `research/github-scan.md`。
3. **README 首页打磨**：一句话介绍、截图、Monad 特性清单、在线地址、如何运行。截图用线上页面。
4. 准备 Mojo 提交所需的描述文字。

### 同事 C：质量与保障（不碰前端核心文件）
1. **真实 MetaMask 验收**：按 `docs/TESTING.md` 的清单走一遍（电脑和手机），把问题整理成清单发给负责人。这是目前最缺的一项。
2. **`web/scripts/preflight.ts`（新建）**：演示前一键检查：公共节点是否可用、各合约地址有代码、演示钱包的 MON 和代币余额、keeper 是否还在清算、线上页面能否访问。
3. **`docs/SECURITY.md`**：威胁模型、信任假设、已知限制（比如测试币任何人可领、清算无需许可、舍入偏向合约、没有审计）。可以尝试运行静态分析工具，结果如实记录。
4. 追加不变量或模糊测试（只新增测试文件）。

### 非代码的并行事项（谁有空谁做）
- **申请专用 RPC 密钥**（QuickNode 或 Alchemy），解决公共节点每秒约 15 个请求的限流。密钥只放在本地环境变量，不要提交。
- **把页面再部署到另一个托管**（Vercel 或 Cloudflare Pages），看 MetaMask 是否还弹"恶意网站"；同时向 Blockaid 提交误报申请。

### 负责人（我这边）
合并和验证 `dev`、改 `App.tsx` 相关集成、部署和 keeper、最终合并到 `main`、现场前的总检查。

## 四、时间节点（按 19:00 截止倒排）

| 时间 | 事项 |
|---|---|
| 现在 – 17:30 | 各自在功能分支开发，小步提交 PR |
| 17:30 | **功能冻结**：之后只修 bug，不加功能 |
| 17:30 – 18:15 | 合并到 `dev`，真实钱包完整测试，修 bug，负责人合并到 `main` |
| 18:15 – 18:40 | 全员按 `docs/DEMO.md` 排练一遍，跑 preflight |
| 18:40 – 19:00 | 在 Mojo 提交，确认仓库公开、README 完整 |

## 五、常见问题

- **冲突了怎么办**：`git pull --rebase origin dev`，按提示解决，保留两边的有效改动。不确定就问。
- **提交错了**：不要强制推送到 `dev` 或 `main`，在群里说，由负责人处理。
- **想知道页面现在是什么状态**：线上地址是 `main` 的内容；`dev` 上的改动要本地运行 `cd web && npm install && npm run dev` 才能看到。
