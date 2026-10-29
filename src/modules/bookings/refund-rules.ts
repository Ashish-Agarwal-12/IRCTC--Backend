// How much of a passenger's fare comes back on cancellation. Pure, so every rule is unit-tested.
//
// Modelled on Indian Railways' e-ticket rules, simplified: no GST on the charges, no TDR
// (claims after chart preparation), and one rule set for every train type. All amounts in paise.

import type { CoachClass, PassengerStatus, Quota } from "../../generated/prisma/client.js";

// Minimum charge for cancelling a confirmed berth, per class.
export const FLAT_CHARGE: Record<CoachClass, number> = { AC1: 24_000, AC2: 20_000, AC3: 18_000, CC: 18_000, SL: 12_000 };
// Charge for cancelling an RAC or waitlisted passenger ("clerkage").
export const CLERKAGE = 6_000;

const HOUR = 60 * 60_000;

export interface RefundInput {
    status: PassengerStatus;   // at the moment of cancelling
    quota: Quota;
    coachClass: CoachClass;
    fare: number;              // what this passenger paid
    msBeforeDeparture: number; // from the passenger's boarding station
}

export interface RefundDecision {
    refund: number;
    charge: number;
    rule: string;              // shown to the user
}

const decide = (fare: number, charge: number, rule: string): RefundDecision => {
    const capped = Math.min(fare, Math.max(0, charge));
    return { refund: fare - capped, charge: capped, rule };
};
const percentOf = (fare: number, percent: number) => Math.ceil((fare * percent) / 100);

export function cancellationRefund({ status, quota, coachClass, fare, msBeforeDeparture }: RefundInput): RefundDecision {
    if (msBeforeDeparture <= 0) return decide(fare, fare, "Train has departed: no refund");

    // RAC / waitlisted: they never held a berth, so only a small fixed charge, up to 30 min before departure.
    if (status === "RAC" || status === "WAITLISTED") {
        if (msBeforeDeparture < 30 * 60_000) return decide(fare, fare, "RAC/WL cancelled less than 30 minutes before departure: no refund");
        return decide(fare, CLERKAGE, "RAC/WL: Rs. 60 clerkage");
    }

    // Confirmed berths.
    if (quota === "TATKAL") return decide(fare, fare, "Confirmed Tatkal: no refund");
    const flat = FLAT_CHARGE[coachClass];
    if (msBeforeDeparture >= 48 * HOUR) return decide(fare, flat, "More than 48 h before departure: flat charge");
    if (msBeforeDeparture >= 12 * HOUR) return decide(fare, Math.max(flat, percentOf(fare, 25)), "12–48 h before departure: 25% (at least the flat charge)");
    if (msBeforeDeparture >= 4 * HOUR) return decide(fare, Math.max(flat, percentOf(fare, 50)), "4–12 h before departure: 50% (at least the flat charge)");
    return decide(fare, fare, "Less than 4 h before departure (chart prepared): no refund");
}
