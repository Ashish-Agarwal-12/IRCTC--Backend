-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN');

-- AlterTable
-- Hand-edited: Prisma's version added a NOT NULL column with no default, which fails on tables
-- that already have rows. Existing trains get placeholder values (departs 00:00, runs daily) that an
-- admin should correct; the defaults are then dropped so every new train must provide real values.
ALTER TABLE "Train"
    ADD COLUMN "departureMinutes" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "runningDays" "Weekday"[] DEFAULT ARRAY['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']::"Weekday"[];

ALTER TABLE "Train"
    ALTER COLUMN "departureMinutes" DROP DEFAULT,
    ALTER COLUMN "runningDays" DROP DEFAULT;

-- CreateTable
CREATE TABLE "FareRule" (
    "class" "CoachClass" NOT NULL,
    "baseFare" INTEGER NOT NULL,
    "perKm" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FareRule_pkey" PRIMARY KEY ("class")
);
