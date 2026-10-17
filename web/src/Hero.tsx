/** First-screen explanation: what problem Pulse addresses, what it does, and how to try it in three steps. */
export function Hero() {
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <section className="hero">
      <div className="hero-cols">
        <div>
          <div className="hero-k">问题</div>
          <p>
            在普通交易所，攻击者能<b>抢在你前面买、在你后面卖</b>（三明治攻击），把你的成交价抬高，自己白赚差价。谁排在前面，谁就占便宜。
          </p>
        </div>
        <div>
          <div className="hero-k good">Pulse 的做法</div>
          <p>
            每个区块是一轮拍卖：区块里的所有订单汇总后，算出<b>一个统一价格</b>，所有成交都按这个价。<b>先后顺序不再值钱</b>，利用顺序赚差价的空间被大大压缩。
          </p>
        </div>
        <div>
          <div className="hero-k">三步试用</div>
          <ol>
            <li>连接钱包（Monad 测试网），领测试币</li>
            <li>下一笔订单，点击时间轴上的区块看它怎么成交</li>
            <li>
              <a onClick={() => jump("attack")}>看底部的"攻击对比"</a>：同一种攻击打在普通 AMM 和 Pulse 上
            </li>
          </ol>
        </div>
      </div>
      <p className="hero-note">
        测试网演示，所有币（MON、pMON、pUSD）都是测试币，没有真实价值。
        <a href="https://github.com/monadpro/Pulse/blob/main/docs/USER_GUIDE.md" target="_blank" rel="noreferrer">使用手册</a>
      </p>
    </section>
  );
}
