# 协作指南：大家都推送到 dev

团队：**负责人 + 同事 B + 同事 C**。目标：并行开发、互不冲突，19:00 前稳定提交。

## 一、分支规则（只有两个分支）

| 分支 | 作用 | 谁推送 |
|---|---|---|
| `main` | **线上版本**。推送后 GitHub Pages 自动部署到 https://monadpro.github.io/Pulse/ ，评委看到的就是它 | **只有负责人**，只合并验证过的 `dev` |
| `dev` | **集成分支**。所有人直接推送到这里 | 所有人 |

不再开其他分支。为了让"大家都推 dev"不出乱子，靠两条：**文件归属**（每个人只改自己的文件，所以不会冲突）和**推送前先同步**。

## 二、每次提交的固定动作

```sh
# 第一次
git clone --recurse-submodules https://github.com/monadpro/Pulse.git && cd Pulse
git checkout dev        # 合约测试需要子模块；漏了就补一句 git submodule update --init

# 之后每次：先同步，再改，再同步，再推
git pull --rebase origin dev
# ……改自己负责的文件……
git add <只加自己改的文件>        # 不要用 git add -A，避免带上别人的或本机的文件
git commit -m "说明做了什么"
git pull --rebase origin dev      # 推送前再同步一次
git push origin dev
```

规则：
1. **小步、常推**：改完一小块就提交推送（至少每 30 分钟一次），别攒一大堆。这样冲突小、负责人也能随时看到进度。
2. **永远不要 `git push --force`**。
3. **只改自己负责的文件**（见下表）。要改别人的文件，先在群里说一声。
4. `git pull --rebase` 提示冲突时：如果冲突文件不是你负责的，**停下来问**，不要硬解。
5. **不要提交 `.env`、私钥、RPC 密钥、截图里含助记词的内容。** `web/src/deployments.json` 只由负责人改。
6. **不要改合约**（`src/`）。合约一改要重新部署，所有人的订单和余额会清零，并要重新验证。确实要改先商量。
7. 新增依赖要先说，页面体积和部署都会受影响。
8. 推送前自查：`cd web && npm run build` 能通过；改了合约相关测试就运行 `forge test`。

## 三、文件归属

| 文件或目录 | 归属 |
|---|---|
| `web/src/`（全部，包括 `App.tsx`、`AttackPanel.tsx`、`style.css`）、`web/index.html` | **负责人** |
| `src/`（合约）、`script/`、`web/src/deployments.json`、`web/scripts/keeper.ts`、`web/scripts/stress.ts`、`web/scripts/bot.ts` | **负责人** |
| `docs/DEMO.md`、`docs/QA.md`、`docs/SUBMISSION.md`、`docs/images/`、`README.md` | **同事 B** |
| `docs/TEST_REPORT.md`、`docs/SECURITY.md`、`docs/OPS.md`、`web/scripts/preflight.ts`、`test/` 下**新增**的测试文件 | **同事 C** |
| 其他已有文档（`USER_GUIDE.md`、`TESTING.md`、`ATTACK_COMPARISON.md`、`PLAN.md`） | 负责人维护；B、C 发现错误请告诉负责人 |

B 和 C 的文件完全不重叠，也不碰 `web/src/`，所以不会和负责人冲突。

## 四、各自的开发计划

- 同事 B：[docs/PLAN_B.md](PLAN_B.md)（演示稿、评委问答、README、提交材料）
- 同事 C：[docs/PLAN_C.md](PLAN_C.md)（真实钱包验收、演示前检查脚本、安全说明、性质测试）

## 五、时间节点（按 19:00 截止倒排）

| 时间 | 事项 |
|---|---|
| 现在 – 17:30 | 各自开发，小步推送到 `dev` |
| **17:30** | **功能冻结**：之后只修 bug 和改文档，不加功能 |
| 17:30 – 18:15 | 负责人合并 `dev` 到 `main`；C 用线上版本完整复测；B 定稿演示稿 |
| 18:15 – 18:40 | 全员按 `docs/DEMO.md` 完整排练，C 跑 `preflight` |
| 18:40 – 19:00 | 在 Mojo 提交，确认仓库公开、README 完整 |

## 六、沟通

- 发现 **P0 问题**（下单失败、页面白屏、资金异常）：立刻直接告诉负责人，不要等整理报告。
- 其他问题记在自己的文档里，定时同步。
- `dev` 上的改动不会影响线上页面；想看 `dev` 的页面效果，本地运行 `cd web && npm install && npm run dev`。
