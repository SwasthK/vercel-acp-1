/*
  Warnings:

  - A unique constraint covering the columns `[spriteId]` on the table `AgentSession` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_spriteId_key" ON "AgentSession"("spriteId");
