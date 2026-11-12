// 駐機場を動く地上の車両（実寸）：ランプバス、給油車、トーイングカー（プッシュバック）、荷物の牽引車と台車、歩く乗客。
// 前が +z、地面が y = 0。どれも 1 種類 = 1 回の描画（InstancedMesh）
import * as THREE from 'three';
import { MeshBuilder } from '../builder';

// car・car2・taxi・coach は陸側のループを走る車（自家用車 2 色・タクシー・リムジンバス）
export type GseType = 'bus' | 'fuel' | 'tug' | 'tractor' | 'cart' | 'pax' | 'car' | 'car2' | 'taxi' | 'coach';
export const GSE_TYPES: GseType[] = ['bus', 'fuel', 'tug', 'tractor', 'cart', 'pax', 'car', 'car2', 'taxi', 'coach'];
// 車両の長さ（m。荷物の台車の間隔などに使う）
export const GSE_LEN: Record<GseType, number> = { bus: 13.5, fuel: 10, tug: 6.2, tractor: 3.0, cart: 3.2, pax: 0.4, car: 4.6, car2: 4.6, taxi: 4.7, coach: 12 };

const C = (h: number) => new THREE.Color(h);
const WHITE = C(0xf0f1f2), DARK = C(0x23262a), GLASS = C(0x24303c), TYRE = C(0x161616), YEL = C(0xf2c230), GREY = C(0x9aa0a6);

function wheels(mb: MeshBuilder, w: number, zs: number[], r: number) {
  for (const z of zs) for (const sd of [-1, 1]) mb.box(sd * w / 2 - (sd > 0 ? 0.35 : 0), 0, z - r, sd * w / 2 + (sd < 0 ? 0.35 : 0), r * 2, z + r, TYRE);
}

function build(mb: MeshBuilder, t: GseType) {
  switch (t) {
    case 'bus': {
      // 低床のランプバス（幅広、窓が大きい、左側に 3 つの扉）
      const w = 3.0, l = 13.5, h = 3.0;
      mb.box(-w / 2, 0.35, -l / 2, w / 2, h, l / 2, WHITE, 0, C(0xd8dadc));
      mb.box(-w / 2 - 0.01, 1.0, -l / 2 + 0.6, w / 2 + 0.01, 2.6, l / 2 - 0.4, GLASS);
      mb.box(-w / 2 - 0.02, 0.4, -l / 2 + 0.3, w / 2 + 0.02, 0.85, l / 2 - 0.3, C(0x2f6fb2));
      mb.box(-w / 2 + 0.2, h, -l / 2 + 2, w / 2 - 0.2, h + 0.3, -l / 2 + 4.5, GREY);
      wheels(mb, w, [-l / 2 + 2.2, l / 2 - 2.2], 0.45);
      break;
    }
    case 'fuel': {
      // 給油車：キャブと、銀色の円いタンク
      const w = 2.5;
      mb.box(-w / 2, 0.6, 3.0, w / 2, 3.0, 5.0, WHITE);
      mb.box(-w / 2 - 0.01, 1.9, 4.2, w / 2 + 0.01, 2.7, 5.01, GLASS);
      mb.box(-w / 2, 0.5, -5.0, w / 2, 1.0, 3.0, DARK);
      const r = 1.2, seg = 10;
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
        const p = (a: number, z: number): [number, number, number] => [Math.cos(a) * r, 2.2 + Math.sin(a) * r, z];
        mb.quadN(p(a1, -4.8), p(a0, -4.8), p(a0, 2.7), p(a1, 2.7), [Math.cos(a1), Math.sin(a1), 0], [Math.cos(a0), Math.sin(a0), 0], [Math.cos(a0), Math.sin(a0), 0], [Math.cos(a1), Math.sin(a1), 0], C(0xc5cacf));
      }
      mb.box(-r, 1.0, -4.85, r, 3.4, -4.75, C(0xb7bcc1));
      mb.box(-r, 3.35, -1, r, 3.5, 2.6, YEL);
      wheels(mb, w, [-3.6, -2.2, 3.9], 0.5);
      break;
    }
    case 'tug': {
      // トーイングカー：低くて幅広い黄色の車（真ん中に小さな運転席）
      const w = 3.2, l = 6.2;
      mb.box(-w / 2, 0.35, -l / 2, w / 2, 1.35, l / 2, YEL, 0, C(0xe0b324));
      mb.box(-0.7, 1.35, -0.8, 0.7, 2.1, 0.8, DARK);
      mb.box(-0.72, 1.6, -0.82, 0.72, 2.0, 0.82, GLASS);
      mb.box(-w / 2, 0.5, l / 2 - 0.2, w / 2, 0.9, l / 2 + 0.1, DARK);
      wheels(mb, w, [-2.0, 2.0], 0.5);
      break;
    }
    case 'tractor': {
      // 荷物の牽引車（オレンジ、屋根だけの運転席）
      const w = 1.6, l = 3.0;
      mb.box(-w / 2, 0.3, -l / 2, w / 2, 1.1, l / 2, C(0xe8772e));
      mb.box(-w / 2, 1.1, -l / 2, -w / 2 + 0.08, 2.0, -l / 2 + 0.1, DARK);
      mb.box(w / 2 - 0.08, 1.1, -l / 2, w / 2, 2.0, -l / 2 + 0.1, DARK);
      mb.box(-w / 2, 2.0, -l / 2, w / 2, 2.1, 0.2, DARK);
      wheels(mb, w, [-0.9, 0.9], 0.3);
      break;
    }
    case 'cart': {
      // 荷物の台車（幌つき）
      const w = 1.6, l = 3.2;
      mb.box(-w / 2, 0.35, -l / 2, w / 2, 0.55, l / 2, GREY);
      mb.box(-w / 2 + 0.05, 0.55, -l / 2 + 0.1, w / 2 - 0.05, 1.7, l / 2 - 0.1, C(0x3c5a7a), 0, C(0x34506d));
      mb.box(-0.6, 0.85, -l / 2 + 0.2, 0.6, 1.45, l / 2 - 0.2, C(0x8a5a3a));
      wheels(mb, w, [-1.0, 1.0], 0.22);
      break;
    }
    case 'car': case 'car2': case 'taxi': {
      // 乗用車（セダン）。タクシーは屋根の行灯と、扉の帯
      const w = 1.8, l = 4.6, body = t === 'car' ? C(0xe8e8e6) : t === 'car2' ? C(0x2a3a52) : C(0xf2c230);
      mb.box(-w / 2, 0.3, -l / 2, w / 2, 0.95, l / 2, body);
      mb.box(-w / 2 + 0.1, 0.95, -l / 2 + 1.0, w / 2 - 0.1, 1.45, l / 2 - 1.2, GLASS);
      mb.box(-w / 2 + 0.15, 1.45, -l / 2 + 1.1, w / 2 - 0.15, 1.5, l / 2 - 1.3, body);
      if (t === 'taxi') {
        mb.box(-0.3, 1.5, -0.2, 0.3, 1.75, 0.2, WHITE);
        mb.box(-w / 2 - 0.01, 0.55, -1.2, w / 2 + 0.01, 0.7, 1.2, C(0x2a2a2a));
      }
      wheels(mb, w, [-l / 2 + 0.9, l / 2 - 0.9], 0.32);
      break;
    }
    case 'coach': {
      // 空港リムジンバス（高床。白に青と金の帯）
      const w = 2.5, l = 12, h = 3.5;
      mb.box(-w / 2, 0.4, -l / 2, w / 2, h, l / 2, WHITE, 0, C(0xd8dadc));
      mb.box(-w / 2 - 0.01, 1.6, -l / 2 + 0.3, w / 2 + 0.01, 3.0, l / 2 - 0.4, GLASS);
      mb.box(-w / 2 - 0.02, 0.8, -l / 2 + 0.2, w / 2 + 0.02, 1.3, l / 2 - 0.2, C(0x1f4f9a));
      mb.box(-w / 2 - 0.02, 1.3, -l / 2 + 0.2, w / 2 + 0.02, 1.42, l / 2 - 0.2, C(0xc9a24a));
      wheels(mb, w, [-l / 2 + 2.2, l / 2 - 2.6], 0.5);
      break;
    }
    case 'pax': {
      // 歩く人（色はインスタンスごと）
      mb.box(-0.22, 0, -0.14, 0.22, 0.85, 0.14, C(0x3a3d44));
      mb.box(-0.25, 0.85, -0.16, 0.25, 1.45, 0.16, WHITE);
      mb.box(-0.12, 1.47, -0.12, 0.12, 1.72, 0.12, C(0xd9b08c));
      mb.box(0.18, 0, -0.35, 0.42, 0.45, -0.05, C(0x2b2b2b)); // 引いているかばん
      break;
    }
  }
}

export function gseGeometry(t: GseType): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  mb.setTransform(0, 0, 0, 0);
  build(mb, t);
  const g = mb.toGeometry();
  for (const k of ['aUvm', 'aPat', 'aMat']) g.deleteAttribute(k);
  return g;
}
