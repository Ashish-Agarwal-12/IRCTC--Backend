-- CreateEnum
CREATE TYPE "CoachClass" AS ENUM ('SL', 'AC3', 'AC2', 'AC1', 'CC');

-- CreateEnum
CREATE TYPE "Quota" AS ENUM ('GENERAL', 'TATKAL', 'LADIES', 'SENIOR_CITIZEN');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BerthType" AS ENUM ('LOWER', 'MIDDLE', 'UPPER', 'SIDE_LOWER', 'SIDE_UPPER', 'WINDOW', 'AISLE');

-- CreateEnum
CREATE TYPE "PassengerStatus" AS ENUM ('CONFIRMED', 'RAC', 'WAITLISTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Passenger" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "gender" TEXT NOT NULL,
    "requestedBerth" "BerthType",
    "status" "PassengerStatus" NOT NULL,
    "racNumber" INTEGER,
    "waitlistNumber" INTEGER,

    CONSTRAINT "Passenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coach" (
    "id" TEXT NOT NULL,
    "trainId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "class" "CoachClass" NOT NULL,

    CONSTRAINT "Coach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "berthType" "BerthType" NOT NULL,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatInventory" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "class" "CoachClass" NOT NULL,
    "quota" "Quota" NOT NULL,
    "totalSeats" INTEGER NOT NULL,
    "availableSeats" INTEGER NOT NULL,
    "racCapacity" INTEGER NOT NULL DEFAULT 0,
    "racBooked" INTEGER NOT NULL DEFAULT 0,
    "waitlistIssued" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeatInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "pnr" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "fromStopId" TEXT NOT NULL,
    "toStopId" TEXT NOT NULL,
    "class" "CoachClass" NOT NULL,
    "quota" "Quota" NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "totalFare" INTEGER NOT NULL,
    "holdExpiresAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatAllocation" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "passengerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeatAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Passenger_bookingId_idx" ON "Passenger"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Coach_trainId_code_key" ON "Coach"("trainId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_coachId_number_key" ON "Seat"("coachId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SeatInventory_scheduleId_class_quota_key" ON "SeatInventory"("scheduleId", "class", "quota");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_pnr_key" ON "Booking"("pnr");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_idempotencyKey_key" ON "Booking"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Booking_userId_idx" ON "Booking"("userId");

-- CreateIndex
CREATE INDEX "Booking_scheduleId_idx" ON "Booking"("scheduleId");

-- CreateIndex
CREATE INDEX "Booking_status_holdExpiresAt_idx" ON "Booking"("status", "holdExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeatAllocation_passengerId_key" ON "SeatAllocation"("passengerId");

-- CreateIndex
CREATE UNIQUE INDEX "SeatAllocation_scheduleId_seatId_key" ON "SeatAllocation"("scheduleId", "seatId");

-- AddForeignKey
ALTER TABLE "Passenger" ADD CONSTRAINT "Passenger_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coach" ADD CONSTRAINT "Coach_trainId_fkey" FOREIGN KEY ("trainId") REFERENCES "Train"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatInventory" ADD CONSTRAINT "SeatInventory_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "TrainSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "TrainSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_fromStopId_fkey" FOREIGN KEY ("fromStopId") REFERENCES "RouteStop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_toStopId_fkey" FOREIGN KEY ("toStopId") REFERENCES "RouteStop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatAllocation" ADD CONSTRAINT "SeatAllocation_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "TrainSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatAllocation" ADD CONSTRAINT "SeatAllocation_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatAllocation" ADD CONSTRAINT "SeatAllocation_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
