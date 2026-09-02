-- Find-my-things: user-taught objects. Names are unique per user (case as
-- stored; lookups normalize client-side). Owner cascade on user delete.

CREATE TABLE "TaughtThing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaughtThing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaughtThing_userId_idx" ON "TaughtThing"("userId");
CREATE UNIQUE INDEX "TaughtThing_userId_name_key" ON "TaughtThing"("userId", "name");

ALTER TABLE "TaughtThing" ADD CONSTRAINT "TaughtThing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
