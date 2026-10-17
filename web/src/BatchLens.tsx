import { tickPrice } from "./format";

const W = 640;
const PAD_L = 40;
const PAD_R = 10;
const N = 64;
const bw = (W - PAD_L - PAD_R) / N;
const xOf = (i: number) => PAD_L + i * bw;
const AXIS = [0, 16, 32, 48, 63];

interface Props {
  bids: number[]; // buy size per price tick
  asks: number[]; // sell size per price tick
  clearTick: number;
  showClear: boolean; // only a cleared batch with volume has a clearing price
}

/** Hand-written SVG (no chart library): the book of one batch and how the clearing price comes out of it. */
export function BatchLens({ bids, asks, clearTick, showClear }: Props) {
  const max = Math.max(1e-9, ...bids, ...asks);
  const H1 = 190;
  const mid = H1 / 2;
  const half = mid - 22;
  const clearX = xOf(clearTick) + bw / 2;

  // cumulative curves: demand(i) = bids at price >= i, supply(i) = asks at price <= i. They cross at the clearing price.
  const demand = Array.from({ length: N }, (_, i) => bids.slice(i).reduce((a, b) => a + b, 0));
  const supply = Array.from({ length: N }, (_, i) => asks.slice(0, i + 1).reduce((a, b) => a + b, 0));
  const top = Math.max(1e-9, demand[0], supply[N - 1]);
  const H2 = 150;
  const y2 = (v: number) => H2 - 24 - (v / top) * (H2 - 44);
  const line = (xs: number[]) => xs.map((v, i) => `${xOf(i) + bw / 2},${y2(v)}`).join(" ");

  return (
    <div className="lens">
      <svg viewBox={`0 0 ${W} ${H1}`} width="100%" role="img" aria-label="每个价格档位的买卖挂单量">
        <text x={PAD_L} y={12} className="svg-title">每个价格档位的挂单量（绿色向上＝买，红色向下＝卖）</text>
        <line x1={PAD_L} x2={W - PAD_R} y1={mid} y2={mid} stroke="#2a3150" />
        {bids.map((v, i) =>
          v > 0 ? (
            <rect key={`b${i}`} x={xOf(i) + 0.5} y={mid - (v / max) * half} width={Math.max(bw - 1, 1)} height={(v / max) * half} fill="#46d39a">
              <title>{`价格 ${tickPrice(i).toFixed(2)}：买 ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} pMON`}</title>
            </rect>
          ) : null,
        )}
        {asks.map((v, i) =>
          v > 0 ? (
            <rect key={`a${i}`} x={xOf(i) + 0.5} y={mid} width={Math.max(bw - 1, 1)} height={(v / max) * half} fill="#ff6b66">
              <title>{`价格 ${tickPrice(i).toFixed(2)}：卖 ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} pMON`}</title>
            </rect>
          ) : null,
        )}
        {showClear && (
          <>
            <line x1={clearX} x2={clearX} y1={16} y2={H1 - 16} stroke="#f5c542" strokeWidth="1.5" strokeDasharray="4 3" />
            <text x={Math.min(clearX + 4, W - 110)} y={28} className="svg-clear">统一清算价 {tickPrice(clearTick).toFixed(2)}</text>
          </>
        )}
        {AXIS.map((i) => (
          <text key={i} x={xOf(i) + bw / 2} y={H1 - 3} textAnchor="middle" className="svg-axis">{tickPrice(i).toFixed(2)}</text>
        ))}
        <text x={4} y={26} className="svg-axis">+{max.toLocaleString(undefined, { maximumFractionDigits: 0 })}</text>
        <text x={4} y={H1 - 18} className="svg-axis">-{max.toLocaleString(undefined, { maximumFractionDigits: 0 })}</text>
      </svg>

      <svg viewBox={`0 0 ${W} ${H2}`} width="100%" role="img" aria-label="累计买盘和卖盘曲线">
        <text x={PAD_L} y={12} className="svg-title">累计曲线：买盘（绿）随价格升高减少，卖盘（红）随价格升高增加，交点附近就是清算价</text>
        <polyline points={line(demand)} fill="none" stroke="#46d39a" strokeWidth="2" />
        <polyline points={line(supply)} fill="none" stroke="#ff6b66" strokeWidth="2" />
        {showClear && <line x1={clearX} x2={clearX} y1={18} y2={H2 - 22} stroke="#f5c542" strokeWidth="1.5" strokeDasharray="4 3" />}
        {AXIS.map((i) => (
          <text key={i} x={xOf(i) + bw / 2} y={H2 - 6} textAnchor="middle" className="svg-axis">{tickPrice(i).toFixed(2)}</text>
        ))}
        <text x={4} y={y2(top) + 4} className="svg-axis">{top.toLocaleString(undefined, { maximumFractionDigits: 0 })}</text>
      </svg>
    </div>
  );
}
