// マップと座標系の基本定数
// グリッド座標: x は東向き、y は南向き。3D では X = x * CELL, Z = y * CELL。

export const CELL = 16; // 1マスの大きさ（m）
export const WATER_LEVEL = 0; // 水面の高さ（m）

// 8方向: 0=東, 1=南東, 2=南, 3=南西, 4=西, 5=北西, 6=北, 7=北東
export const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;
export const opp = (d: number) => (d + 4) & 7;
export const isDiag = (d: number) => (d & 1) === 1;

export function dirOf(dx: number, dy: number): number {
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
}

// ゲーム内時間
export const DAYS_PER_MONTH = 30;
// 速度ごとの「1か月の実時間（秒）」。0 は停止。
// 速度ごとの1か月の長さ（実時間の秒）：一時停止、1倍、2倍、4倍。車や列車の動き・昼夜も同じ倍率で速くなる
export const SPEED_MONTH_SECONDS = [0, 60, 30, 15] as const;
export const SPEED_SCALE = [0, 1, 2, 4] as const;

export const MAX_ROAD_GRADE = 0.12; // 道路の最大勾配（12%）
