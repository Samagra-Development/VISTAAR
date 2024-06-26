import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getStationId,
  mapIMDItems,
  mapAdvisoryData,
  mapOUATWeather,
} from './app.utils';
import { firstValueFrom, map } from 'rxjs';
import { generateContext } from './beckn.utils';

@Injectable()
export class AppService {
  private readonly logger: Logger;
  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.logger = new Logger();
  }

  getHello(): string {
    return 'Hello World!';
  }

  private async getDataFromOUAT(lat: string, long: string) {
    const geoIPBaseURL = this.configService.get<string>('GEOIP_BASE_URL');
    const locData = await this.httpService.axiosRef.get(
      geoIPBaseURL + `/georev?lat=${lat}&lon=${long}`,
    );

    if (locData.data.state !== 'ODISHA') {
      throw new InternalServerErrorException(
        'We only OUAT data only for the state of ODISHA right now.',
      );
    }
    // figure out district
    const district = locData.data.district.toLowerCase();

    // fetching data from OUAT
    const ouatBaseURL = this.configService.get<string>('OUAT_BASE_URL');
    const enableOld = this.configService.get<string>('OUAT_ENABLE_OLD');
    if (enableOld.trim() == 'true') {
      const ouatData = await this.httpService.axiosRef.get(
        ouatBaseURL + `/history/31-05-2024_${district}.json`,
      );

      ouatData.data['district'] = district;
      return ouatData.data;
    } else {
      const ouatData = await this.httpService.axiosRef.get(
        ouatBaseURL + `/latest/${district}.json`,
      );
      ouatData.data['district'] = district;
      return ouatData.data;
    }
  }

  private async getWeatherFromIMD(lat: string, long: string) {
    try {
      const dist = this.configService.get<number>('IMD_MIN_STATION_DISTANCE');
      const stationId = getStationId(lat, long, dist);
      if (!stationId) {
        throw new InternalServerErrorException(
          'No IMD weather station found for the sent coordinates.',
        );
      }
      const baseURL = this.configService.get<string>('IMD_BASE_URL');
      const urls = [
        `${baseURL}/api/cityweather_loc.php?id=${stationId}`,
        `${baseURL}/api/current_wx_api.php?id=${stationId}`,
        `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat}%2C${long}?unitGroup=metric&key=UFQNJT8FL927DT7HNQME9HWSL&contentType=json`,
      ];

      const apiCalls = urls.map((url: string) => {
        return firstValueFrom(this.httpService.get(url));
      });

      const [forecastData, currentData, visualCrossing] =
        await Promise.all(apiCalls);
      return {
        sevenDay: forecastData.data,
        current: currentData.data,
        visualCrossing: visualCrossing.data,
      };
    } catch (err) {
      this.logger.error('Error resolving API Calls', err);
    }
  }

  private async getWeatherFromVisualCrossing(lat: string, long: string) {
    // TODO: Turn this into a proper provider
    try {
      const visualCrossingURL = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat}%2C${long}?unitGroup=metric&key=UFQNJT8FL927DT7HNQME9HWSL&contentType=json`;
      const data = await this.httpService.axiosRef.get(visualCrossingURL);
      console.log('data', data);
      return data;
    } catch (err) {
      this.logger.error('error fetching data from visual crossing ', err);
    }
  }

  async getAdvisoryFromUpcar() {
    const upcarBaseURL = this.configService.get<string>('UPCAR_BASE_URL');

    try {
      const upcarData = await this.httpService.axiosRef.get(
        upcarBaseURL + '/latest.json',
      );

      return upcarData.data;
    } catch (err) {
      this.logger.error('Error while fetching advisory data from UPCAR', err);
    }
  }

  async getHindiAdvisoryFromUpcar() {
    const upcarBaseURL = this.configService.get<string>('UPCAR_BASE_URL');

    try {
      const upcarData = await this.httpService.axiosRef.get(
        upcarBaseURL + '/latest_hindi.json',
      );

      return upcarData.data;
    } catch (err) {
      this.logger.error('Error while fetching advisory data from UPCAR', err);
    }
  }

  async getWeather(lat: string, long: string) {
    let imdItems = undefined,
      upcarItems = undefined,
      ouatWeatherItems = undefined,
      ouatAdvisoryItems = undefined;
    // IMD Data
    try {
      const imdData = await this.getWeatherFromIMD(lat, long);
      console.log('imdData: ', imdData);
      imdItems = mapIMDItems(imdData);
    } catch (err) {
      this.logger.error('Error fetching weather data from IMD', err);
    }
    // VISUAL CROSSING
    // try {
    //   const visualCrossingData = await this.getWeatherFromVisualCrossing(
    //     lat,
    //     long,
    //   );
    // } catch (err) {
    //   this.logger.error('error mapping data from visual crossing', err);
    // }
    try {
      const upcarData = await this.getAdvisoryFromUpcar();
      upcarItems = mapAdvisoryData(upcarData, 'upcar');
      const upcarHindiData = await this.getHindiAdvisoryFromUpcar();
      const upcarHindiProvider = mapAdvisoryData(upcarHindiData, 'upcar');
      const hindiItems = upcarHindiProvider.items.map((item) => {
        item.category_ids.push('hi_translated');
        return item;
      });
      upcarItems.items.push(...hindiItems);
      upcarItems.categories.push({
        id: 'hi_translated',
      });
    } catch (err) {
      this.logger.error('Error fetching advisory data from UPCAR', err);
    }
    let ouatData = undefined;
    try {
      ouatData = await this.getDataFromOUAT(lat, long);
      if (ouatData['ERROR']) {
        throw new InternalServerErrorException(
          `OUAT API is failing with the following error: ${ouatData['ERROR']}`,
        );
      }

      ouatWeatherItems = mapOUATWeather(ouatData);
      ouatAdvisoryItems = mapAdvisoryData(ouatData, 'ouat');
    } catch (err) {
      ouatData = undefined;
      this.logger.error('error getting data from OUAT', err);
      this.logger.warn('skipped adding data from OUAT');
    }
    // const mapped = transformIMDDataToBeckn(imdData.sevenDay);
    return {
      context: generateContext(),
      message: {
        catalog: {
          providers: [
            imdItems ? imdItems : undefined,
            ouatWeatherItems ? ouatWeatherItems : undefined,
            upcarItems ? upcarItems : undefined,
            ouatAdvisoryItems ? ouatAdvisoryItems : undefined,
          ].filter((item) => item != undefined),
        },
      },
    };
  }
}
