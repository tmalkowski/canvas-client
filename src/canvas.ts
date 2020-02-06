import { HttpsAgent } from 'agentkeepalive'
import Axios, { AxiosInstance } from 'axios'
import flatten from 'lodash/flatten'
import range from 'lodash/range'
import pLimit from 'p-limit'
import parselinkheader from 'parse-link-header'
import qs from 'qs'
import { CanvasAccount, CanvasCourse, CanvasSection, CanvasEnrollment, CanvasEnrollmentPayload, CanvasCoursePayload, CanvasSectionPayload, CanvasGradingStandard, CanvasID, SpecialUserID, SpecialSectionID, SISSectionID, SISUserID, CanvasEnrollmentShortType, SpecialCourseID } from './interfaces'

export class CanvasConnector {
  private service: AxiosInstance
  private rateLimit = pLimit(10)

  constructor (canvasUrl: string, token?: string, options: CanvasAPIOptions = {}) {
    const maxConnections = options.maxConnections || 10
    this.rateLimit = pLimit(maxConnections)
    this.service = Axios.create({
      baseURL: canvasUrl + '/api/v1',
      timeout: 20000,
      httpsAgent: new HttpsAgent({ maxSockets: maxConnections }),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'Content-Type': 'application/json'
      }
    })
  }

  tasks () {
    return this.rateLimit.pendingCount + this.rateLimit.activeCount
  }

  async get (url: string, params: any = {}): Promise<any> {
    const res = await this.rateLimit(() => this.service.get(url, { params }))
    return res.data
  }

  async getall (url: string, params: any = {}): Promise<any[]> {
    const res = await this.rateLimit(() => this.service.get(url, { params: { ...params, page: 1, per_page: 1000 } }))
    const ret = res.data
    const links = parselinkheader(res.headers.link)
    const lasturl = links?.last?.url
    if (lasturl) {
      const lastparams = qs.parse(lasturl.slice(lasturl.lastIndexOf('?') + 1))
      if (lastparams.page > 1) {
        const alldata = await Promise.all(range(2, lastparams.page + 1).map(async p => {
          const res = await this.rateLimit(() => this.service.get(url, { params: { ...lastparams, page: p } }))
          return res.data || []
        }))
        ret.push(...flatten(alldata))
      }
    }
    return ret
  }

  async delete (url: string, params: any = {}): Promise<any> {
    const res = await this.rateLimit(() => this.service.delete(url, { params }))
    return res.data
  }

  async put (url: string, payload: any): Promise<any> {
    const res = await this.rateLimit(() => this.service.put(url, payload))
    return res.data
  }

  async post (url: string, payload: any): Promise<any> {
    const res = await this.rateLimit(() => this.service.post(url, payload))
    return res.data
  }

  async head (url: string): Promise<boolean> {
    return this.rateLimit(async () => {
      try {
        const res = await this.service.head(url)
        return res.status >= 200 && res.status < 400
      } catch (e) {
        return false
      }
    })
  }
}

interface CanvasAPIOptions {
  maxConnections?: number
}

export class CanvasAPI {
  private connectors: CanvasConnector[]

  constructor (canvasUrl: string|undefined, tokens?: string[], options?: CanvasAPIOptions) {
    if (!canvasUrl || !canvasUrl.length) throw new Error('Instantiated a canvas client with no URL.')
    if (tokens && !tokens.length) throw new Error('Instantiated a canvas client with an empty token array. If creating the client in the browser and depending on cookies, do not include tokens parameter at all.')
    if (!tokens) this.connectors = [new CanvasConnector(canvasUrl, undefined, options)]
    else this.connectors = tokens.map(token => new CanvasConnector(canvasUrl, token, options))
  }

  getConnector () {
    return this.connectors.reduce((leastBusyConnector, connector) => connector.tasks() < leastBusyConnector.tasks() ? connector : leastBusyConnector, this.connectors[0])
  }

  async get (url: string, params: any = {}): Promise<any> {
    return this.getConnector().get(url, params)
  }

  async getall (url: string, params: any = {}): Promise<any[]> {
    return this.getConnector().getall(url, params)
  }

  async delete (url: string, params: any = {}): Promise<any> {
    return this.getConnector().delete(url, params)
  }

  async put (url: string, payload: any): Promise<any> {
    return this.getConnector().put(url, payload)
  }

  async post (url: string, payload: any): Promise<any> {
    return this.getConnector().post(url, payload)
  }

  async head (url: string): Promise<boolean> {
    return this.getConnector().head(url)
  }

  // DEFAULTS
  public defaultCourseTimeZone = 'America/Chicago'

  // ACCOUNTS
  public async getRootAccounts (): Promise<CanvasAccount[]> {
    return this.getall('/accounts')
  }

  public async getSubAccounts (id: CanvasID): Promise<CanvasAccount[]> {
    return this.getall(`/accounts/${id}/sub_accounts`, { recursive: true })
  }

  public async getRootAccount (): Promise<CanvasAccount|undefined> {
    const accounts = await this.getRootAccounts()
    return accounts[0]
  }

  // COURSES
  public async getUserCourses (userId?: CanvasID|SpecialUserID): Promise<CanvasCourse[]> {
    return this.getall(`/users/${userId || 'self'}/courses`)
  }

  public async getUserCoursesBySIS (userId: SISUserID) {
    return this.getUserCourses(`sis_user_id:${userId}`)
  }

  public async getCourse (courseId: CanvasID): Promise<CanvasCourse> {
    return this.get(`/courses/${courseId}`)
  }

  public async getCourses (accountId?: CanvasID, params?: { published?: boolean, enrollment_type?: CanvasEnrollmentShortType[] }): Promise<CanvasCourse[]> {
    if (!accountId) accountId = (await this.getRootAccount())?.id
    if (!accountId) return []
    return this.getall(`/accounts/${accountId}/courses`, params)
  }

  public async createCourse (accountId: CanvasID, coursePayload: CanvasCoursePayload): Promise<CanvasCourse> {
    if (!coursePayload.course.time_zone) coursePayload.course.time_zone = this.defaultCourseTimeZone
    return this.post(`/accounts/${accountId}/courses`, coursePayload)
  }

  // GRADING STANDARDS
  public async getGradingStandards (accountId?: CanvasID): Promise<CanvasGradingStandard[]> {
    if (!accountId) accountId = (await this.getRootAccount())?.id
    if (!accountId) return []
    return this.getall(`/accounts/${accountId}/grading_standards`)
  }

  // SECTIONS
  public async courseSections (courseId?: CanvasID): Promise<CanvasSection[]> {
    if (!courseId) return []
    return this.getall(`/courses/${courseId}/sections`)
  }

  public async getSection (id: CanvasID|SpecialSectionID): Promise<CanvasSection> {
    return this.get(`/sections/${id}`)
  }

  public async getSectionBySIS (sisId: SISSectionID) {
    return this.getSection(`sis_section_id:${sisId}`)
  }

  public async courseSectionsBatched (courseIds: CanvasID[]): Promise<CanvasSection[]> {
    return Promise.all(courseIds.map(id => this.courseSections(id)))
      .then(flatten)
  }

  public async createSection (courseId: CanvasID, sectionPayload: CanvasSectionPayload): Promise<CanvasSection> {
    return this.post(`/courses/${courseId}/sections`, sectionPayload)
  }

  public async createSections (courseId: CanvasID, sectionPayloads: CanvasSectionPayload[]): Promise<CanvasSection[]> {
    return Promise.all(sectionPayloads.map((payload: CanvasSectionPayload) => this.createSection(courseId, payload)))
  }

  public async deleteSection (id: CanvasID|SpecialSectionID) {
    const enrollments = await this.getSectionEnrollments(id)
    await Promise.all(enrollments.map(enrollment => this.deactivateEnrollmentFromSection(enrollment)))
    await this.removeSISFromSection(id)
    await this.delete(`/sections/${id}`)
  }

  public async deleteSectionBySIS (sisId: SISSectionID) {
    return this.deleteSection(`sis_section_id:${sisId}`)
  }

  public async removeSISFromSection (id: CanvasID|SpecialSectionID) {
    await this.put(`/sections/${id}`, CanvasSectionPayload.asVoidSISSectionId())
  }

  public async removeSISFromSectionBySIS (sisId: SISSectionID) {
    return this.removeSISFromSection(`sis_section_id:${sisId}`)
  }

  public async removeSISFromSectionsBySIS (sisIds: SISSectionID[]) {
    return Promise.all(sisIds.map(sisId => this.removeSISFromSectionBySIS(sisId)))
  }

  public async sectionExists (id: CanvasID|SpecialSectionID) {
    return this.head(`/sections/${id}`)
  }

  public async sectionsExist (ids: (CanvasID|SpecialSectionID)[]) {
    return Promise.all(ids.map(id => this.sectionExists(id)))
  }

  public sectionExistsBySIS (sisId: SISSectionID) {
    return this.sectionExists(`sis_section_id:${sisId}`)
  }

  public sectionsExistBySIS (sisIds: SISSectionID[]) {
    return Promise.all(sisIds.map(sisId => this.sectionExists(sisId)))
  }

  // ENROLLMENTS
  public async getCourseEnrollments (id: CanvasID|SpecialCourseID): Promise<CanvasEnrollment[]> {
    return this.getall(`/courses/${id}/enrollments`)
  }

  public async getSectionEnrollments (id: CanvasID|SpecialSectionID): Promise<CanvasEnrollment[]> {
    return this.getall(`/sections/${id}/enrollments`)
  }

  public async getSectionEnrollmentsBySIS (sisId: SISSectionID): Promise<CanvasEnrollment[]> {
    return this.getSectionEnrollments(`sis_section_id:${sisId}`)
  }

  public async createEnrollment (courseId: CanvasID, enrollmentPayload: CanvasEnrollmentPayload) {
    return this.post(`/courses/${courseId}/enrollments`, enrollmentPayload)
  }

  public async deactivateEnrollmentFromSection (enrollment: CanvasEnrollment) {
    return this.delete(`/courses/${enrollment.course_id}/enrollments/${enrollment.id}`, { task: 'deactivate' })
  }
}
