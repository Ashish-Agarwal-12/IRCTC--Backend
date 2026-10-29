-- Passenger order within a booking ("passenger 1, 2, 3"), so tickets list passengers as entered.
-- No default needed: there are no passengers yet. On a table with rows, add a default first.
DROP INDEX "Passenger_bookingId_idx";

ALTER TABLE "Passenger" ADD COLUMN "position" INTEGER NOT NULL;

-- Also serves lookups by bookingId (it's the first column), which is why the old index can go.
CREATE UNIQUE INDEX "Passenger_bookingId_position_key" ON "Passenger"("bookingId", "position");
