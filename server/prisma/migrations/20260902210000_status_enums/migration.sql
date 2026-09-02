-- Convert free-text status columns to real enums (hardening pass completion).
-- Any unexpected legacy value would abort the USING cast — acceptable: the
-- routes only ever wrote the documented values.

CREATE TYPE "JourneyStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'ESCALATED');
ALTER TABLE "Journey" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Journey" ALTER COLUMN "status" TYPE "JourneyStatus" USING "status"::text::"JourneyStatus";
ALTER TABLE "Journey" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE TYPE "EmergencyStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'RESOLVED', 'EXPIRED');
ALTER TABLE "EmergencySession" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "EmergencySession" ALTER COLUMN "status" TYPE "EmergencyStatus" USING "status"::text::"EmergencyStatus";
ALTER TABLE "EmergencySession" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'REVIEWED', 'REMOVED');
ALTER TABLE "IncidentReport" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "IncidentReport" ALTER COLUMN "status" TYPE "IncidentStatus" USING "status"::text::"IncidentStatus";
ALTER TABLE "IncidentReport" ALTER COLUMN "status" SET DEFAULT 'OPEN';
