-- Phase 9: cancellations, refunds, RAC/WL promotion.
-- Hand-written: Prisma's generated SQL dropped "waitlistIssued" and added "waitlistBooked" fresh,
-- which would lose the counts. This renames it and recomputes the queues instead.

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSED');

-- AlterEnum (PostgreSQL 12+ allows several ADD VALUE in one migration)
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'STATUS_CHANGED';

-- AlterTable
ALTER TABLE "OutboxMessage" ADD COLUMN "payload" JSONB;

-- RAC and waitlist numbers change meaning: from "ticket issued at booking time" to "current
-- position in the queue". Make existing data follow the new rule.
ALTER TABLE "SeatInventory" RENAME COLUMN "waitlistIssued" TO "waitlistBooked";

-- Cancelled passengers hold no place in any queue.
UPDATE "Passenger" SET "racNumber" = NULL, "waitlistNumber" = NULL WHERE status = 'CANCELLED';

-- Close the gaps left by earlier releases: positions 1..n per schedule + class + quota, same order.
UPDATE "Passenger" AS p SET "racNumber" = q.n
FROM (
    SELECT p2.id, ROW_NUMBER() OVER (
        PARTITION BY b."scheduleId", b.class, b.quota ORDER BY p2."racNumber", b."createdAt", p2.position) AS n
    FROM "Passenger" p2 JOIN "Booking" b ON b.id = p2."bookingId"
    WHERE p2.status = 'RAC'
) AS q
WHERE p.id = q.id;

UPDATE "Passenger" AS p SET "waitlistNumber" = q.n
FROM (
    SELECT p2.id, ROW_NUMBER() OVER (
        PARTITION BY b."scheduleId", b.class, b.quota ORDER BY p2."waitlistNumber", b."createdAt", p2.position) AS n
    FROM "Passenger" p2 JOIN "Booking" b ON b.id = p2."bookingId"
    WHERE p2.status = 'WAITLISTED'
) AS q
WHERE p.id = q.id;

-- Counters = the actual queue lengths.
UPDATE "SeatInventory" AS i SET
    "racBooked" = (
        SELECT count(*) FROM "Passenger" p JOIN "Booking" b ON b.id = p."bookingId"
        WHERE b."scheduleId" = i."scheduleId" AND b.class = i.class AND b.quota = i.quota AND p.status = 'RAC'),
    "waitlistBooked" = (
        SELECT count(*) FROM "Passenger" p JOIN "Booking" b ON b.id = p."bookingId"
        WHERE b."scheduleId" = i."scheduleId" AND b.class = i.class AND b.quota = i.quota AND p.status = 'WAITLISTED');

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "gatewayRefundId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_gatewayRefundId_key" ON "Refund"("gatewayRefundId");

-- CreateIndex
CREATE INDEX "Refund_status_createdAt_idx" ON "Refund"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Refund_bookingId_idx" ON "Refund"("bookingId");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
