import { Router } from 'express'
import {
  analytics,
  audit,
  entityCreate,
  entityDelete,
  entityGet,
  entityList,
  entityStatus,
  entityUpdate,
  facultyCreate,
  facultyDelete,
  facultyGet,
  facultyList,
  facultyUpdate,
  overview,
  settings,
  updateSettings,
} from '../controllers/systemController.js'
import { authenticate, authorize } from '../middleware/authMiddleware.js'

const router = Router()

router.use(authenticate, authorize('super-admin'))
router.get('/overview', overview)
router.get('/analytics', analytics)
router.get('/audit', audit)
router.get('/settings', settings)
router.put('/settings', updateSettings)
router.get('/faculty', facultyList)
router.post('/faculty', facultyCreate)
router.get('/faculty/:id', facultyGet)
router.patch('/faculty/:id', facultyUpdate)
router.delete('/faculty/:id', facultyDelete)
router.get('/:entity', entityList)
router.post('/:entity', entityCreate)
router.get('/:entity/:id', entityGet)
router.patch('/:entity/:id', entityUpdate)
router.patch('/:entity/:id/status', entityStatus)
router.delete('/:entity/:id', entityDelete)

export default router