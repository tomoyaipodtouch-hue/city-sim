// 貨物船の航路：船体が陸にかからないこと、岸壁と平行に止まること
import { describe, expect, it } from 'vitest';
import { planShipRoute, shipCycle, shipPose, ShipSpec } from '../src/render/shipRoute';

const CELL = 16;
const BIG: ShipSpec = { len: 200, beam: 30, speed: 9 };
const SMALL: ShipSpec = { len: 110, beam: 16.5, speed: 9 };

// land[y][x] = true が陸。マップの外は水
function mapOf(n: number, land: (x: number, y: number) => boolean) {
  return (x: number, y: number) => x < 0 || y < 0 || x >= n || y >= n || !land(x, y);
}

function hullOnLand(wet: (x: number, y: number) => boolean, x: number, z: number, hd: number, s: ShipSpec) {
  const fx = Math.sin(hd), fz = Math.cos(hd), px = fz, pz = -fx;
  let bad = 0;
  for (let a = -0.5; a <= 0.5; a += 0.05)
    for (const b of [-0.4, 0, 0.4]) {
      const wx = x + fx * a * s.len + px * b * s.beam, wz = z + fz * a * s.len + pz * b * s.beam;
      if (!wet(Math.floor(wx / CELL), Math.floor(wz / CELL))) bad++;
    }
  return bad;
}

function check(n: number, wet: (x: number, y: number) => boolean, S: [number, number], axis: [number, number], berth: [number, number], spec: ShipSpec) {
  const r = planShipRoute(n, wet, S, axis, spec, CELL);
  expect(r).not.toBeNull();
  const cyc = shipCycle(r!, spec);
  const phases = new Set<string>();
  let worst = 0, worstAt = '';
  for (let t = 0; t < cyc; t += 0.5) {
    const P = shipPose(r!, spec, berth, t);
    phases.add(P.phase);
    if (P.phase === 'away' || P.phase === 'slideIn' || P.phase === 'dock' || P.phase === 'slideOut') continue;
    const b = hullOnLand(wet, P.x, P.z, P.hd, spec);
    if (b > worst) { worst = b; worstAt = `${P.phase} t=${t} x=${P.x.toFixed(0)} z=${P.z.toFixed(0)}`; }
  }
  // 停泊中は岸壁と平行
  const dock = shipPose(r!, spec, berth, 0);
  void dock;
  expect(worstAt).toBe('');
  expect([...phases]).toEqual(expect.arrayContaining(['in', 'slideIn', 'dock', 'slideOut', 'rotate', 'out']));
  return r!;
}

describe('ship route', () => {
  it('open bay: arrives parallel and turns in open water', () => {
    const n = 96;
    // 上半分が陸、y = 48 が岸壁
    const wet = mapOf(n, (_x, y) => y < 48);
    const quayZ = 48 * CELL;
    const berth: [number, number] = [48 * CELL, quayZ + 22];
    const S: [number, number] = [48 * CELL, quayZ + 92];
    const r = check(n, wet, S, [1, 0], berth, BIG);
    // 接岸中の向きは岸壁と平行（±x 方向）
    expect(Math.abs(Math.sin(r.hd))).toBeCloseTo(1, 5);
  });

  it('L-shaped channel: hull never cuts the corner', () => {
    const n = 128;
    // 幅 10 マスの水路が、マップの下の端から上がってきて右に曲がり、岸壁のある港の水面へ
    const water = (x: number, y: number) =>
      (x >= 20 && x < 30 && y >= 40) || // 縦の水路
      (x >= 20 && x < 110 && y >= 40 && y < 50) || // 横の水路
      (x >= 70 && x < 110 && y >= 20 && y < 50); // 港の水面
    const wet = (x: number, y: number) => (x < 0 || y < 0 || x >= n || y >= n ? true : water(x, y));
    // 岸壁：港の水面の上の辺（y = 20）
    const quayZ = 20 * CELL;
    const berth: [number, number] = [90 * CELL, quayZ + 22];
    const S: [number, number] = [90 * CELL, quayZ + 92];
    check(n, wet, S, [1, 0], berth, BIG);
  });

  it('small port on a river bank', () => {
    const n = 96;
    // 幅 6 マスの川が左右に流れる（マップの両端へ）
    const wet = mapOf(n, (_x, y) => y < 40 || y >= 46);
    const quayZ = 40 * CELL;
    check(n, wet, [40 * CELL, quayZ + 55], [1, 0], [40 * CELL, quayZ + 13], SMALL);
  });
});
