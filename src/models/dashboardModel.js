const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function dateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function listUserSchedules(database, user) {
  const filter = user.role === 'faculty'
    ? { facultyId: user.id }
    : user.programId && user.cohort
      ? { programId: user.programId, cohort: user.cohort }
      : { departmentId: user.departmentId }
  const schedules = await database.collection('schedules').find({ ...filter, status: 'Published' }).toArray()
  const [rooms, faculty, departments] = await Promise.all([
    database.collection('rooms').find({ id: { $in: schedules.map((item) => item.roomId) } }).toArray(),
    database.collection('users').find({ id: { $in: schedules.map((item) => item.facultyId) } }).toArray(),
    database.collection('departments').find({ id: { $in: schedules.map((item) => item.departmentId) } }).toArray(),
  ])
  const roomById = new Map(rooms.map((item) => [item.id, item]))
  const facultyById = new Map(faculty.map((item) => [item.id, item]))
  const departmentById = new Map(departments.map((item) => [item.id, item]))
  const dayOrder = weekdays
  return schedules.map((schedule) => ({
    id: schedule.id, day: schedule.day, start: schedule.start, end: schedule.end,
    course: schedule.subject, code: schedule.code, group: schedule.cohort,
    room: roomById.get(schedule.roomId)?.name, instructor: facultyById.get(schedule.facultyId)?.name,
    department: departmentById.get(schedule.departmentId)?.name,
  })).sort((left, right) => dayOrder.indexOf(left.day) - dayOrder.indexOf(right.day) || left.start.localeCompare(right.start))
}

function makeWeekDates(offset) {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const mondayOffset = (today.getDay() + 6) % 7
  today.setDate(today.getDate() - mondayOffset + offset * 7)
  return weekdays.map((day, index) => {
    const date = new Date(today)
    date.setDate(today.getDate() + index)
    return { day, date: dateKey(date) }
  })
}

function getToday() {
  const today = new Date()
  return {
    date: dateKey(today),
    day: weekdays[(today.getDay() + 6) % 7],
    label: new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(today),
    time: `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`,
  }
}

export async function getDashboardTimetable(database, user, requestedOffset = 0) {
  const offset = Number.isInteger(Number(requestedOffset)) ? Math.max(-52, Math.min(52, Number(requestedOffset))) : 0
  const today = getToday()
  const schedules = await listUserSchedules(database, user)
  const todayClasses = schedules.filter((item) => item.day === today.day)
  const dates = makeWeekDates(offset)
  const classesByDay = new Map(weekdays.map((day) => [day, []]))
  for (const schedule of schedules) classesByDay.get(schedule.day)?.push(schedule)
  const week = dates.map(({ day, date }, index) => ({
    day,
    date,
    dayIndex: index,
    classes: classesByDay.get(day),
  }))
  const ongoingClass = todayClasses.find((item) => item.start <= today.time && item.end > today.time)
  const nextClass = ongoingClass || todayClasses.find((item) => item.start > today.time)

  return {
    today: { date: today.date, day: today.day, label: today.label, classes: todayClasses },
    week,
    weekStart: dates[0].date,
    weekEnd: dates[6].date,
    summary: {
      todayCount: todayClasses.length,
      weekCount: week.reduce((count, day) => count + day.classes.length, 0),
      nextClass: nextClass ? { start: nextClass.start, end: nextClass.end, course: nextClass.course, live: nextClass === ongoingClass } : null,
    },
  }
}