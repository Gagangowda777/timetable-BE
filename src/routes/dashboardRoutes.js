import { Router } from 'express'
import {
	createFacultyChange,
	facultyChangeRequests,
	notifications,
	timetable,
	facultyWorkload,
	facultyLeaveRequests,
	createFacultyLeave,
	requestFormFields,
} from '../controllers/dashboardController.js'
import { authenticate, authorize } from '../middleware/authMiddleware.js'

const router = Router()

router.use(authenticate, authorize('student', 'faculty'))
router.get('/timetable', timetable)
router.get('/workload', authorize('faculty'), facultyWorkload)
router.get('/notifications', authorize('student'), notifications)
router.get('/request-form-fields', authorize('faculty'), requestFormFields)
router.get('/change-requests', authorize('faculty'), facultyChangeRequests)
router.post('/change-requests', authorize('faculty'), createFacultyChange)
router.get('/leave-requests', authorize('faculty'), facultyLeaveRequests)
router.post('/leave-requests', authorize('faculty'), createFacultyLeave)

export default router