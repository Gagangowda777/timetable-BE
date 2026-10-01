import { Router } from 'express'
import {
  bootstrap,
  changeRequests,
  createSchedule,
  getCalendar,
  manualTimetableOptions,
  manualTimetableEntries,
  validateManualTimetableController,
  manualTimetableVersions,
  createManualTimetableVersionController,
  generateManualTimetableController,
  createManualTimetableEntryController,
  updateManualTimetableEntryController,
  deleteManualTimetableEntryController,
  reports,
  reviewChangeRequest,
  resolveConflict,
  updateCalendar,
  updateFacultyAvailability,
  updateScheduleStatus,
  facultyWorkloadReport,
  facultyWorkloadDetails,
} from '../controllers/adminController.js'
import { authenticate, authorize } from '../middleware/authMiddleware.js'

const router = Router()

router.use(authenticate, authorize('department-admin', 'academic-admin'))
router.get('/bootstrap', bootstrap)
router.post('/schedules', createSchedule)
router.patch('/schedules/status', updateScheduleStatus)
router.get('/change-requests', changeRequests)
router.patch('/change-requests/:id', reviewChangeRequest)
router.patch('/faculty/:id/availability', updateFacultyAvailability)
router.get('/faculty-workload', facultyWorkloadReport)
router.get('/faculty/:id/workload', facultyWorkloadDetails)
router.patch('/conflicts/:id/resolve', resolveConflict)
router.get('/calendar', getCalendar)
router.put('/calendar', updateCalendar)
router.get('/manual-timetable/options', manualTimetableOptions)
router.get('/manual-timetable/entries', manualTimetableEntries)
router.get('/manual-timetable/versions', manualTimetableVersions)
router.post('/manual-timetable/versions', createManualTimetableVersionController)
router.post('/manual-timetable/validate', validateManualTimetableController)
router.post('/manual-timetable/generate', generateManualTimetableController)
router.post('/manual-timetable/entries', createManualTimetableEntryController)
router.patch('/manual-timetable/entries/:id', updateManualTimetableEntryController)
router.delete('/manual-timetable/entries/:id', deleteManualTimetableEntryController)
router.get('/reports/schedules', reports)

export default router