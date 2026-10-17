import { useEffect, useState } from "react";
import { addrs, publicHttp } from "./chainClients";
import { explorer } from "./format";
import { useBatches } from "./useBatches";
import "./landing.css";

const REPO = "https://github.com/monadpro/Pulse";
const go = (hash: string) => {
  location.hash = hash;
  window.scrollTo(0, 0);
};
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

/** Animated sketch of one batch: orders arrive from both sides and everything clears at one price. */
function HeroVisual({ block }: { block?: number }) {
  const bids = [34, 52, 70, 88, 104];
  const asks = [30, 46, 66, 80, 98];
  return (
    <div className="ln-visual">
      <svg viewBox="0 0 520 300" role="img" aria-label="同一个区块里的买单和卖单按同一个价格成交的示意动画">
        <rect x="1" y="1" width="518" height="298" rx="16" fill="none" stroke="rgba(255,255,255,0.08)" />
        <text x="20" y="28" fill="#8b93a7" fontSize="13">区块 {block ?? "···"} · 一轮拍卖</text>
        <line x1="20" x2="500" y1="150" y2="150" stroke="#2a3150" />
        {bids.map((h, i) => (
          <rect key={`b${i}`} className="bid" x={70 + i * 36} y={150 - h} width="26" height={h} rx="5" fill="#46d39a" style={{ animationDelay: `${i * 0.12}s` }} />
        ))}
        {asks.map((h, i) => (
          <rect key={`a${i}`} className="ask" x={280 + i * 36} y={150} width="26" height={h} rx="5" fill="#ff6b66" style={{ animationDelay: `${i * 0.12}s` }} />
        ))}
        <g className="clear">
          <line x1="260" x2="260" y1="44" y2="268" stroke="#f5c542" strokeWidth="2" strokeDasharray="6 5" />
          <rect x="196" y="44" width="128" height="26" rx="13" fill="#f5c542" />
          <text x="260" y="62" textAnchor="middle" fontSize="13" fontWeight="700" fill="#0b0d14">统一价 1.00</text>
        </g>
        <text x="70" y="288" fill="#46d39a" fontSize="12">买单</text>
        <text x="448" y="288" fill="#ff6b66" fontSize="12">卖单</text>
      </svg>
      <div className="cap">示意图：同一区块里的所有成交，都按黄线这一个价格</div>
    </div>
  );
}

export function Landing() {
  const { stats, loaded, error } = useBatches();
  const [head, setHead] = useState<number>();
  useEffect(() => {
    let stop = false;
    const tick = () => publicHttp.getBlockNumber().then((n) => !stop && setHead(Number(n))).catch(() => {});
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const n = (v?: number) => (loaded && v !== undefined ? v.toLocaleString() : "…");
  const contracts: [string, string][] = [
    ["PulseExchange 交易所", addrs.exchange],
    ["pMON（被交易的币）", addrs.base],
    ["pUSD（计价的币）", addrs.quote],
    ["SimpleAMM（对比用）", addrs.amm],
    ["AttackLab（实验用）", addrs.lab],
  ];

  return (
    <div className="landing">
      <nav className="ln-nav">
        <div className="ln-wrap">
          <div className="ln-logo">
            <svg width="26" height="26" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#14182b" /><polyline points="3,17 10,17 13,7 18,25 21,17 29,17" fill="none" stroke="#46d39a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Pulse
          </div>
          <div className="ln-links">
            <a onClick={() => scrollTo("how")}>原理</a>
            <a onClick={() => scrollTo("proof")}>对比</a>
            <a onClick={() => scrollTo("monad")}>Monad</a>
            <a onClick={() => scrollTo("scope")}>边界</a>
            <a onClick={() => scrollTo("verify")}>可验证</a>
          </div>
          <button className="ln-btn ln-primary small" onClick={() => go("#/app")}>进入应用 →</button>
        </div>
      </nav>

      <div className="ln-wrap">
        <header className="ln-hero">
          <div>
            <span className="ln-badge">Monad 测试网 · 合约已验证</span>
            <h1>一个区块，<br /><span>一个价格</span></h1>
            <p className="ln-tagline">Monad 上的逐块统一价现货交易引擎 · 测试网原型</p>
            <p className="lead">
              Pulse 是链上的逐块批量拍卖。同一个区块里的所有订单汇总后，按<b>同一个价格</b>成交：谁先谁后不再值钱，利用交易顺序赚差价的空间被大大压缩。
            </p>
            <div className="ln-cta">
              <button className="ln-btn ln-primary" onClick={() => go("#/app")}>进入应用</button>
              <button className="ln-btn ln-ghost" onClick={() => scrollTo("proof")}>看攻击对比</button>
            </div>
          </div>
          <HeroVisual block={head} />
        </header>

        <div className="ln-stats">
          <div className="ln-stat"><b>{n(head)}</b><span>当前区块高度</span></div>
          <div className="ln-stat"><b>{n(stats?.orders)}</b><span>累计订单</span></div>
          <div className="ln-stat"><b>{n(stats?.settled)}</b><span>已清算批次</span></div>
          <div className="ln-stat"><b>{n(stats?.maxBatch)}</b><span>历史单区块最多订单</span></div>
        </div>
        {error && <p className="ln-note">链上数据暂时无法加载（公共节点限流），稍后会自动重试。</p>}

        <section className="ln-sec" id="how">
          <h2>三步完成一次公平成交</h2>
          <p className="sub">下单、统一清算、领取。每一步都在链上完成，资金始终在合约里，没有人能挪用。</p>
          <div className="ln-grid3">
            <div className="ln-card"><div className="ln-num">1</div><h3>下单，押金入合约</h3><p>选择方向、价格档位和数量。买单冻结对应的 pUSD，卖单冻结 pMON，订单进入当前区块的批次。</p></div>
            <div className="ln-card"><div className="ln-num">2</div><h3>区块结束，统一清算</h3><p>合约把这一批订单汇总成买卖曲线，找出成交量最大的价格，所有成交都按这个价格。清算是固定的 64 档扫描，成本不随订单数增长。</p></div>
            <div className="ln-card"><div className="ln-num">3</div><h3>领取成交与退款</h3><p>买到的币和多冻结的押金回到钱包，没成交的部分全额退回。领取可以由自动清算脚本代劳。</p></div>
          </div>
          <div className="ln-example">
            <b>举个例子：</b>你愿意最高以 <b>1.05 pUSD</b> 买入 <b>100 pMON</b>，先托管 105 pUSD。本批清算价是 <b>1.00</b> 且全部成交：实际支付 100，<b>退回 5</b>，得到 100 pMON。
            <span>你填的是价格上限，实际执行的是统一清算价。</span>
          </div>
        </section>

        <section className="ln-sec" id="proof">
          <h2>同一种攻击，两个结果</h2>
          <p className="sub">三明治攻击：攻击者抢在你前面买、在你后面卖，赚走差价。下面是链上受控模拟的实测结果：同一个攻击，分别打在普通 AMM 和 Pulse 上。</p>
          <div className="ln-vs">
            <div className="side bad">
              <h3>普通 AMM</h3>
              <div className="big">多付 23.88%</div>
              <ul><li>受害者本应买到 949.66 pMON，实际只买到 722.84</li><li>攻击者净赚 230.93 pUSD</li><li>价格由交易的先后顺序决定</li></ul>
            </div>
            <div className="side good">
              <h3>Pulse</h3>
              <div className="big">多付 0%</div>
              <ul><li>统一成交价 1.00，受害者按原价买到 1,000 pMON</li><li>攻击者净利润约 0</li><li>同一区块内，先后顺序不影响价格</li></ul>
            </div>
          </div>
          <p className="ln-note">
            这是<b>链上受控模拟</b>，不是真实攻击记录：AttackLab 合约同时扮演攻击者、受害者和流动性提供者（初始池子 20,000 对 20,000，首次运行的数字）。
            Pulse 并不能阻止所有价格操纵，只是让"靠顺序赚差价"这条路走不通。你可以在应用里自己运行一遍。
            <a className="lnk" onClick={() => go("#/app")}> 去运行 →</a>
          </p>
        </section>

        <section className="ln-sec" id="monad">
          <h2>为 Monad 而设计的细节</h2>
          <p className="sub">机制本身在别的链上也能运行；Monad 让"每个区块一轮拍卖"的等待短到几乎感觉不到。</p>
          <div className="ln-grid4">
            <div className="ln-card"><div className="ln-num">⚡</div><h3>300ms 出块</h3><p>每个区块就是一轮拍卖，下单到成交不到一秒。</p></div>
            <div className="ln-card"><div className="ln-num">∞</div><h3>固定成本的清算</h3><p>清算约 15.5 万到 17.5 万 gas，不随订单数增长。链上已有单区块 {n(stats?.maxBatch)} 笔订单被一次清算。</p></div>
            <div className="ln-card"><div className="ln-num">✓</div><h3>真实的区块状态</h3><p>页面订阅 Monad 的区块状态推送，展示 Proposed、Voted、Finalized、Verified，并把推算出来的状态单独标出。</p></div>
            <div className="ln-card"><div className="ln-num">▦</div><h3>贴合存储设计</h3><p>同一档位的买卖共用一个存储位，64 档订单簿对齐到一页，清算只读一页。</p></div>
          </div>
        </section>

        <section className="ln-sec" id="scope">
          <h2>适合做什么，边界在哪</h2>
          <p className="sub">先把话说清楚：这是测试网原型，下面左边是我们认为适合的方向，右边是目前的真实状态。</p>
          <div className="ln-vs">
            <div className="ln-card">
              <h3>适用方向（产品设想，尚未接入业务）</h3>
              <ul className="ln-list">
                <li><b>现货代币市场</b>：买卖双方按区块集中竞价，规则透明。需要稳定的做市方。</li>
                <li><b>应用内的交易入口</b>：例如游戏资源代币的兑换。需要应用接入和足够的双边流动性。</li>
                <li><b>教学、研究与开发者演示</b>：对比 AMM 与批量拍卖，看懂三明治攻击。<b>这是现在就能用的</b>。</li>
              </ul>
            </div>
            <div className="ln-card">
              <h3>当前边界（如实说明）</h3>
              <ul className="ln-list">
                <li>测试网原型，<b>合约未经审计</b>；单一交易对，价格是 64 个固定档位。</li>
                <li>订单<b>只参与当前区块</b>，没有撤单；这一批没有对手单就不成交，押金全额退回。</li>
                <li>清算和领取需要有人触发并支付 gas，目前由自动脚本代劳；还没有协议收费和激励设计。</li>
                <li>同一区块内的排序保护，<b>不等于消除所有 MEV</b>。</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="ln-sec" id="verify">
          <h2>全部可验证</h2>
          <p className="sub">合约已在 MonadVision 验证，源码、测试和文档都在 GitHub 上。</p>
          <div className="ln-card">
            <div className="ln-addr">
              {contracts.map(([name, a]) => (
                <div key={a} style={{ display: "contents" }}>
                  <span>{name}</span>
                  <code>{explorer ? <a className="lnk" href={`${explorer}/address/${a}`} target="_blank" rel="noreferrer">{a}</a> : a}</code>
                </div>
              ))}
            </div>
            <p className="ln-note">
              <a className="lnk" href={REPO} target="_blank" rel="noreferrer">GitHub 仓库</a> ·{" "}
              <a className="lnk" href={`${REPO}/blob/main/docs/ATTACK_COMPARISON.md`} target="_blank" rel="noreferrer">攻击对比说明</a> ·{" "}
              <a className="lnk" href={`${REPO}/blob/main/docs/USER_GUIDE.md`} target="_blank" rel="noreferrer">使用手册</a>
            </p>
          </div>
        </section>

        <footer className="ln-foot">
          <button className="ln-btn ln-primary" onClick={() => go("#/app")}>进入应用</button>
          <p>
            Pulse 是黑客松演示项目，运行在 Monad 测试网，所有币（MON、pMON、pUSD）都是测试币，没有真实价值；合约未经审计，请勿用于真实资金。
          </p>
        </footer>
      </div>
    </div>
  );
}
