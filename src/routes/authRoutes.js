import { Router } from 'express'
import { currentUser, login } from '../controllers/authController.js'
import { authenticate } from '../middleware/authMiddleware.js'

const router = Router()

router.post('/login', login)
router.get('/me', authenticate, currentUser)

export default router