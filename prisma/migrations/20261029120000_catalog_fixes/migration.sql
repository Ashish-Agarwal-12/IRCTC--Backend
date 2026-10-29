-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'TRANSGENDER');

-- AlterTable
-- Hand-edited: Prisma's generated SQL drops and re-adds the column, which would delete existing
-- data. Converting in place keeps existing rows (values must already match the enum, case-insensitive).
ALTER TABLE "Passenger" ALTER COLUMN "gender" TYPE "Gender" USING UPPER("gender")::"Gender";

-- AlterTable
ALTER TABLE "TrainSchedule" ALTER COLUMN "chartPreparedAt" DROP NOT NULL;
