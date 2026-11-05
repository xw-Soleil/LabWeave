export namespace Telemetry {
  /**
   * 不上报，数据只留在本机
   * @param _event 字符串，原则上不能塞入动态的参数，如文件名、路径、日期、时间等
   * @param _data 任意对象类型
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export async function event(_event: string, _data: any = {}) {}
}
