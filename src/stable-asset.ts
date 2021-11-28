
import { Observable, combineLatest, BehaviorSubject } from 'rxjs';
import { from } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';
import { assert } from '@polkadot/util';
import { forceToCurrencyId, MaybeCurrency, Token } from '@acala-network/sdk-core';
import { CurrencyId, Position, AccountId } from '@acala-network/types/interfaces';
import { DerivedLoanType } from '@acala-network/api-derive';
import { ApiRx } from '@polkadot/api';
import { Option } from '@polkadot/types/codec';
import { Codec } from '@polkadot/types/types';
import { memoize } from 'lodash';
import { FixedPointNumber } from '@acala-network/sdk-core/fixed-point-number';
import { BigNumber } from 'bignumber.js';

export interface PoolInfo {
  poolAsset: CurrencyId,
  assets: CurrencyId[],
  precisions: BigNumber[],
  mintFee: BigNumber,
  swapFee: BigNumber,
  redeemFee: BigNumber,
  totalSupply: BigNumber,
  a: BigNumber,
  balances: BigNumber[],
  feeRecipient: AccountId
}

export interface SwapResult {
  outputAmount: FixedPointNumber,
  feeAmount: FixedPointNumber
}

export interface MintResult {
  outputAmount: FixedPointNumber,
  feeAmount: FixedPointNumber
}

export class StableAssetRx {
  private api: ApiRx;

  constructor(api: ApiRx) {
    this.api = api;
  }

  public getAvailablePools(): Observable<PoolInfo[]> {
    return this.api.query.stableAsset.poolCount()
      .pipe(
        mergeMap(res => {
          let count: unknown = res;
          let arr = [];
          for (let i = 0; i < (count as number); i++) {
            arr.push(this.getPoolInfo(i));
          }
          return combineLatest(arr);
      }));
  }

  public getPoolInfo(poolId: number): Observable<PoolInfo> {
    return this.api.query.stableAsset.pools(poolId).pipe(map(poolInfoOption => {
      let poolInfo: any = (poolInfoOption as Option<Codec>).unwrap();
      return {
        poolAsset: poolInfo.poolAsset,
        assets: poolInfo.assets,
        precisions: this.convertToFixPointNumber(poolInfo.precisions),
        mintFee: new BigNumber(poolInfo.mintFee.toString()),
        swapFee: new BigNumber(poolInfo.swapFee.toString()),
        redeemFee: new BigNumber(poolInfo.redeemFee.toString()),
        totalSupply: new BigNumber(poolInfo.totalSupply.toString()),
        a: new BigNumber(poolInfo.a.toString()),
        balances: this.convertToFixPointNumber(poolInfo.balances),
        feeRecipient: poolInfo.feeRecipient
      }
    }));
  }

  private convertToFixPointNumber(a: any[]): BigNumber[] {
    let result: BigNumber[] = [];
    for (let i = 0; i < a.length; i++) {
      result.push(new BigNumber(a[i].toString()));
    }
    return result;
  }

  private getD(balances: BigNumber[], a: BigNumber): BigNumber {
    let sum: BigNumber = new BigNumber(0);
    let ann: BigNumber = a;
    let balanceLength: BigNumber = new BigNumber(balances.length);
    let one: BigNumber = new BigNumber(1);

    for (let i = 0; i < balances.length; i++) {
      sum = sum.plus(balances[i]);
      ann = ann.times(balanceLength);
    }
    if (sum.isZero()) {
      return new BigNumber(0);
    }

    let prevD: BigNumber = new BigNumber(0);
    let d: BigNumber = sum;
    for (let i = 0; i < 255; i++) {
      let pD: BigNumber = d;
      for (let j = 0; j < balances.length; j++) {
        pD = pD.times(d).div(balances[j].times(balanceLength));
      }
      prevD = d;
      d = ann
      .times(sum)
      .plus(pD.times(balanceLength))
      .times(d)
      .div(ann.minus(one).times(d).plus(balanceLength.plus(one).times(pD)));
      if (d > prevD) {
        if (d.minus(prevD).isLessThanOrEqualTo(one)) {
          break;
        }
      } else {
        if (prevD.minus(d).isLessThanOrEqualTo(one)) {
          break;
        }
      }
    }

    return d;
  }

  private getY(balances: BigNumber[], j: number, d: BigNumber, a: BigNumber): BigNumber {
    let c: BigNumber = d;
    let sum: BigNumber = new BigNumber(0);
    let ann: BigNumber = a;
    let balanceLength: BigNumber = new BigNumber(balances.length);
    let one: BigNumber = new BigNumber(1);

    for (let i = 0; i < balances.length; i++) {
      ann = ann.times(balanceLength);
      if (i == j) {
        continue;
      }
      sum = sum.plus(balances[i]);
      c = c.times(d).div(balances[i].times(balanceLength));
    }
    c = c.times(d).div(ann.times(balanceLength));
    let b: BigNumber = sum.plus(d.div(ann));
    let prevY: BigNumber = new BigNumber(0);
    let y: BigNumber = d;

    for (let i = 0; i < 255; i++) {
      prevY = y;
      y = y.times(y).plus(c).div(y.times(new BigNumber(2)).plus(b).minus(d));
      if (y > prevY) {
        if (y.minus(prevY).isLessThanOrEqualTo(one)) {
          break;
        }
      } else {
        if (prevY.minus(y).isLessThanOrEqualTo(one)) {
          break;
        }
      }
    }

    return y;
  }

  public getSwapAmount(poolId: number, input: number, output: number, inputAmount: FixedPointNumber): Observable<SwapResult> {
    return this.getPoolInfo(poolId).pipe(map((poolInfo) => {
      let feeDenominator: BigNumber = new BigNumber("10000000000");
      let balances: BigNumber[] = poolInfo.balances;
      let a: BigNumber = poolInfo.a;
      let d: BigNumber = poolInfo.totalSupply;
      balances[input] = balances[input].plus(inputAmount._getInner().times(poolInfo.precisions[output]));
      let y: BigNumber = this.getY(balances, output, d, a);
      let dy: BigNumber = balances[output].minus(y).minus(new BigNumber(1)).div(poolInfo.precisions[output]);

      let feeAmount: BigNumber = new BigNumber(0);
      if (poolInfo.swapFee.isGreaterThan(new BigNumber(0))) {
        feeAmount = dy.times(poolInfo.swapFee).div(feeDenominator);
        dy = dy.minus(feeAmount);
      }
      console.log("dy: " + dy);
      if (dy.isLessThan(new BigNumber(0))) {
        return {
          outputAmount: new FixedPointNumber(0),
          feeAmount: new FixedPointNumber(0)
        }
      }
      return {
        outputAmount: FixedPointNumber._fromBN(dy, inputAmount.getPrecision()),
        feeAmount: FixedPointNumber._fromBN(feeAmount, inputAmount.getPrecision())
      };
    }));
  }

  public swap(poolId: number, input: number, output: number, inputAmount: FixedPointNumber, minOutput: FixedPointNumber) {
    return this.api.tx.stableAsset.swap(poolId, input, output, inputAmount, minOutput);
  }

  public getMintAmount(poolId: number, inputAmounts: FixedPointNumber[]): Observable<MintResult> {
    return this.getPoolInfo(poolId).pipe(map((poolInfo) => {
      let balances: BigNumber[] = poolInfo.balances;
      let a: BigNumber = poolInfo.a;
      let oldD: BigNumber = poolInfo.totalSupply;
      let feeDenominator: BigNumber = new BigNumber("10000000000");

      for (let i = 0; i < balances.length; i++) {
        if (inputAmounts[i].isZero()) {
          continue;
        }
        // balance = balance + amount * precision
        balances[i] = balances[i].plus(inputAmounts[i]._getInner().times(poolInfo.precisions[i]));
      }
      let newD: BigNumber = this.getD(balances, a);
      // newD should be bigger than or equal to oldD
      let mintAmount: BigNumber = newD.minus(oldD);
      let feeAmount: BigNumber = new BigNumber(0);

      if (poolInfo.mintFee.isGreaterThan(new BigNumber(0))) {
        feeAmount = mintAmount.times(poolInfo.mintFee).div(feeDenominator);
        mintAmount = mintAmount.minus(feeAmount);
      }

      return {
        outputAmount: FixedPointNumber._fromBN(mintAmount, inputAmounts[0].getPrecision()),
        feeAmount: FixedPointNumber._fromBN(feeAmount, inputAmounts[0].getPrecision())
      };
    }));

  }

  public mint(poolId: number, inputAmounts: FixedPointNumber[], minMintAmount: FixedPointNumber) {
    return this.api.tx.stableAsset.swap(poolId, inputAmounts, minMintAmount);
  }
}
