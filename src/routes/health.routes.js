import { Router } from "express";

const router = Router();

router.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "hirerise-core",
    mode: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

export default router;