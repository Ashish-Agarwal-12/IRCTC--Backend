// Chooses physical berths for the confirmed passengers of one booking. Pure: it gets the list of
// free seats (read under the inventory lock) and returns which ones to take.

import type { BerthType } from "../../generated/prisma/client.js";

export interface FreeSeat {
    id: string;
    coachCode: string;
    number: number;
    berthType: BerthType;
}

// "B2" before "B10": numeric-aware comparison, then seat number.
export function bySeatOrder(a: FreeSeat, b: FreeSeat): number {
    return a.coachCode.localeCompare(b.coachCode, "en", { numeric: true }) || a.number - b.number;
}

// One seat per entry in `preferences` (undefined = no preference).
// 1. Passengers with a preference get the first free berth of that type, if there is one.
// 2. Everyone else gets the first free seat, preferring the coach the party is already in, so a
//    family isn't scattered across the train.
// The caller guarantees there are enough free seats: the inventory counters never confirm more
// passengers than there are berths. If that's ever false, it's a bug, so fail loudly.
export function pickSeats(free: FreeSeat[], preferences: (BerthType | undefined)[]): FreeSeat[] {
    if (free.length < preferences.length) {
        throw new Error(`Inventory says ${preferences.length} berths are free but only ${free.length} seats are`);
    }
    const pool = [...free].sort(bySeatOrder);
    const take = (index: number) => pool.splice(index, 1)[0];
    const picked: (FreeSeat | undefined)[] = preferences.map(() => undefined);

    preferences.forEach((preference, i) => {
        if (!preference) return;
        const index = pool.findIndex((seat) => seat.berthType === preference);
        if (index !== -1) picked[i] = take(index);
    });

    preferences.forEach((_, i) => {
        if (picked[i]) return;
        const partyCoach = picked.find((seat) => seat)?.coachCode;
        const sameCoach = partyCoach ? pool.findIndex((seat) => seat.coachCode === partyCoach) : -1;
        picked[i] = take(sameCoach !== -1 ? sameCoach : 0);
    });

    return picked as FreeSeat[];
}
