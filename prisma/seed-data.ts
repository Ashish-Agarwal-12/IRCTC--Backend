// Sample catalog for local development. Station codes and train names are real; timetables,
// distances and coach lists are approximate and only meant to make search and booking testable.

import type { CoachClass, Weekday } from "../src/generated/prisma/client.js";

export const stations = [
    { code: "NDLS", name: "New Delhi", city: "Delhi" },
    { code: "NZM", name: "Hazrat Nizamuddin", city: "Delhi" },
    { code: "MTJ", name: "Mathura Junction", city: "Mathura" },
    { code: "AGC", name: "Agra Cantt", city: "Agra" },
    { code: "GWL", name: "Gwalior Junction", city: "Gwalior" },
    { code: "VGLJ", name: "Virangana Lakshmibai Jhansi", city: "Jhansi" },
    { code: "BPL", name: "Bhopal Junction", city: "Bhopal" },
    { code: "KOTA", name: "Kota Junction", city: "Kota" },
    { code: "RTM", name: "Ratlam Junction", city: "Ratlam" },
    { code: "BRC", name: "Vadodara Junction", city: "Vadodara" },
    { code: "ST", name: "Surat", city: "Surat" },
    { code: "MMCT", name: "Mumbai Central", city: "Mumbai" },
    { code: "CNB", name: "Kanpur Central", city: "Kanpur" },
    { code: "PRYJ", name: "Prayagraj Junction", city: "Prayagraj" },
    { code: "DDU", name: "Pt. Deen Dayal Upadhyaya Junction", city: "Chandauli" },
    { code: "GAYA", name: "Gaya Junction", city: "Gaya" },
    { code: "ASN", name: "Asansol Junction", city: "Asansol" },
    { code: "HWH", name: "Howrah Junction", city: "Kolkata" },
];

const ALL_DAYS: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// Builds a coach list like B1..B8 for one class.
function coachSet(prefix: string, coachClass: CoachClass, count: number) {
    return Array.from({ length: count }, (_, i) => ({ code: `${prefix}${i + 1}`, class: coachClass }));
}

// Stops: [stationCode, arrivalMinutes, departureMinutes, distanceKm], times relative to origin departure.
type Stop = [string, number | null, number | null, number];

export const trains: {
    number: string; name: string; runningDays: Weekday[]; departureTime: string;
    stops: Stop[]; coaches: { code: string; class: CoachClass }[];
}[] = [
    {
        number: "12952", name: "Mumbai Rajdhani Express", runningDays: ALL_DAYS, departureTime: "16:55",
        stops: [
            ["NDLS", null, 0, 0], ["KOTA", 270, 275, 465], ["RTM", 515, 518, 733],
            ["BRC", 690, 700, 993], ["ST", 790, 793, 1122], ["MMCT", 955, null, 1386],
        ],
        coaches: [...coachSet("H", "AC1", 1), ...coachSet("A", "AC2", 4), ...coachSet("B", "AC3", 8)],
    },
    {
        number: "12302", name: "Howrah Rajdhani Express", runningDays: ["MON", "TUE", "WED", "FRI", "SAT", "SUN"], departureTime: "16:50",
        stops: [
            ["NDLS", null, 0, 0], ["CNB", 290, 295, 440], ["PRYJ", 410, 412, 634],
            ["DDU", 535, 545, 787], ["GAYA", 680, 683, 990], ["ASN", 880, 882, 1216], ["HWH", 1050, null, 1447],
        ],
        coaches: [...coachSet("H", "AC1", 1), ...coachSet("A", "AC2", 3), ...coachSet("B", "AC3", 6)],
    },
    {
        number: "12156", name: "Bhopal Express", runningDays: ALL_DAYS, departureTime: "20:40",
        stops: [
            ["NZM", null, 0, 0], ["MTJ", 140, 142, 141], ["AGC", 195, 200, 195],
            ["GWL", 315, 318, 313], ["VGLJ", 400, 410, 410], ["BPL", 640, null, 705],
        ],
        coaches: [...coachSet("A", "AC2", 1), ...coachSet("B", "AC3", 4), ...coachSet("S", "SL", 6)],
    },
    {
        number: "12280", name: "Taj Express", runningDays: ["MON", "TUE", "WED", "THU", "FRI", "SAT"], departureTime: "07:10",
        stops: [
            ["NZM", null, 0, 0], ["MTJ", 140, 142, 141], ["AGC", 205, 210, 195],
            ["GWL", 335, 340, 313], ["VGLJ", 450, null, 410],
        ],
        coaches: coachSet("C", "CC", 4),
    },
];

// Paise. Roughly: base fare + per-km rate, before reservation charges, GST, Tatkal surcharge, etc.
export const fareRules: { class: CoachClass; baseFare: number; perKm: number }[] = [
    { class: "SL", baseFare: 2_500, perKm: 45 },
    { class: "CC", baseFare: 3_000, perKm: 100 },
    { class: "AC3", baseFare: 4_000, perKm: 120 },
    { class: "AC2", baseFare: 5_000, perKm: 175 },
    { class: "AC1", baseFare: 6_000, perKm: 300 },
];

export const SCHEDULE_DAYS_AHEAD = 60;
