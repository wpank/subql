import { SubstrateExtrinsic } from '@subql/types';
import {Nomination, Nominator, Validator, ValidatorNomination} from "../types";
const { decodeAddress, encodeAddress } = require('@polkadot/keyring');
const { hexToU8a, isHex } = require('@polkadot/util');

// Process a staking.nominate transaction
export async function handleNominate(extrinsic: SubstrateExtrinsic): Promise<void> {
    // Get the extrinsic hash and block number
    const extrinsicHash = extrinsic.block.block.header.hash.toString();
    const blockNumber = extrinsic.block.block.header.number.toNumber()

    // A staking.nominate transaction is initiated from a controller account
    //     get the controller and the nomination targets
    //@ts-ignore
    const { signer, method: {args}} = extrinsic.extrinsic.toHuman();
    const { targets } = args;
    const controller = signer['Id'] ? signer['Id'] : signer
    const nominatorTargets = targets.map((target)=>{
        const address = target['Id'] ? target['Id'] : target
        if (isValidAddressPolkadotAddress(address)) return
    })

    // On Chain Queries
    //     get the stash from the controller, the bonded amount, and the current era
    const ledgerQuery = (await api.query.staking.ledger(controller)).toJSON()
    const nominatorStash = ledgerQuery['stash']
    const nominatorBond = BigInt(ledgerQuery['total'])
    const currentEra = (await api.query.staking.currentEra()).toString();

    // Update the nominators bond and current nominations and create a `Nomination` record
    await updateNominator(nominatorStash, nominatorTargets, currentEra, nominatorBond)
    await createNomination(extrinsicHash, nominatorStash, blockNumber)

    const nominations = await Promise.all(targets.map(async (target) => {
        const validatorStash = target["Id"] ? target['Id'] : target
        await updateValidator(validatorStash, currentEra, nominatorStash, nominatorBond)
        const validatorNominationId = `${nominatorStash}-${validatorStash}-${blockNumber}`
        await createValidatorNomination(validatorNominationId, blockNumber, nominatorStash, validatorStash, extrinsicHash, nominatorBond)
    }));
}


// Update the nominator entry
//     - If the nominator doesn't already exist, create a record for them
//     - Check the diff of whether the nominator removed any previous validators from their nomination
//     - update the current validator targets, the era the tx was submitted in, and the bond
const updateNominator = async(nominatorStash, nominatorTargets, submittedIn, bond) => {
    await ensureNominator(nominatorStash)
    const nominator = await Nominator.get(nominatorStash)

    await updateRemovedValidators(nominator, nominatorTargets)

    nominator.currentValidators = nominatorTargets
    nominator.submittedIn = submittedIn
    nominator.bond = bond
    await nominator.save()
}

// Called before updating the current validators of a nominator
// This takes the diff of the old validators and new validators
//     if the validator was removed from the nomination, removes the nominator
//     from the list of `allNominators` for the validator
const updateRemovedValidators = async(nominator, nominatorTargets) => {
    // Get the current set of validators prior to the nominator tx taking place
    const prevValidators = nominator.currentValidators

    // If they had previous validators they were nominating and there was some that were removed,
    //    remove them from the list of `allNominators`, `activeNominators`, and `inactiveNominators`
    if (prevValidators){
        // Find which validators may have been removed from their nominators
        const removedValidators = prevValidators.filter(x => !nominatorTargets.includes(x))
        // const removedValidators = prevValidators.filter(prevVal => !nominatorTargets.some(nomTarget => nomTarget.stash === prevVal.stash))
        for (const val of removedValidators) {
            await ensureValidator(val)
            const validator = await Validator.get(val)
            const allNominators = validator.allNominators
            const activeNominators = validator.activeNominators
            const inactiveNominators = validator.inactiveNominators
            if (allNominators){
                const index = allNominators.map(nominator => {return nominator.stash}).indexOf(nominator.stash)
                if (index > -1){
                    // Remove nominator from list of `allNomiantors`
                    allNominators.splice(index, 1);
                    validator.allNominators = allNominators

                    // Update Total Stake Amounts
                    let totalStake = BigInt(0)
                    for (const nom of allNominators){
                        // const nominator = await  Nominator.get(nom.stash.toString())
                        if (nom && BigInt(nom.bond) > 0){
                            totalStake += BigInt(nom.bond)
                        }
                    }
                    validator.totalStake = totalStake
                }
            }
            if (activeNominators){
                const index = activeNominators.map(nominator => {return nominator.stash}).indexOf(nominator.stash)
                if (index > -1){
                    activeNominators.splice(index, 1);
                    validator.activeNominators = activeNominators
                }
            }
            if (inactiveNominators){
                const index = inactiveNominators.map(nominator => {return nominator.stash}).indexOf(nominator.stash)
                if (index > -1){
                    // Remove nominator from list of `inactiveValidators`
                    inactiveNominators.splice(index, 1);
                    validator.inactiveNominators = inactiveNominators

                    // Update inactive stake amounts
                    let inactiveStake = BigInt(0)
                    for (const nom of inactiveNominators){
                        // const nominator = await Nominator.get(nom.stash.toString())
                        if (nom && BigInt(nom.bond) > 0){
                            inactiveStake += BigInt(nom.bond)
                        }
                    }
                    validator.inactiveStake = inactiveStake
                }
            }
            await validator.save();
        }
    }
}

// Update a Validator's list of active and inactive Nominators, as well as totals for active/inactive stake amounts
const updateValidator = async(validatorStash, currentEra, nominatorStash, nominatorBond) => {

    // Get Era Exposure
    let erasStakers
    // Prior to runtime 1050, `staking.Stakers` was the storage item
    if (api.query.staking.stakers){
        erasStakers = (await api.query.staking.stakers(validatorStash));
    }
    if  (api.query.staking.erasStakers){
        erasStakers = (await api.query.staking.erasStakers(currentEra, validatorStash));
    }

    // @ts-ignore
    const {total, own, others} = erasStakers
    const activeNominators = others.map((nominator)=> {
        return {stash: nominator.who.toString(), bond: nominator.value.toString()}
    })

    let validator = await Validator.get(validatorStash);
    let allNominators
    if (!validator) {
        validator = new Validator(validatorStash);
        validator.stash = validatorStash;
        allNominators = [{stash: nominatorStash, bond: nominatorBond.toString()}]

    } else {
        // The validator was included in a nominators nomination
        //  add the nominator to the list of all nominators if it isn't already there
        allNominators = validator.allNominators
        const index = validator.allNominators.map(nominator => {return nominator.stash}).indexOf(nominatorStash)
        if (index == -1){
            allNominators.push({stash: nominatorStash, bond: nominatorBond.toString()})
        }
    }

    // Inactive nominators are the diff between all nominators and active nominators
    const inactiveNominators = allNominators.filter(nominator => !activeNominators.some(activeNominator => activeNominator.stash === nominator.stash))
    validator.inactiveNominators = inactiveNominators

    // Total stake is the sum of stake from all nominators, active and inactive
    let totalStake = BigInt(0)
    for (const nom of allNominators){
        // const nominator = await  Nominator.get(nom.stash.toString())
        if (nom && BigInt(nom.bond) > 0){
            totalStake += BigInt(nom.bond)
        }
    }

    let inactiveStake = BigInt(0)
    for (const nom of inactiveNominators){
        // const nominator = await Nominator.get(nom.stash.toString())
        if (nom && BigInt(nom.bond) > 0){
            inactiveStake += BigInt(nom.bond)
        }
    }

    validator.totalStake = totalStake
    validator.activeStake = total
    validator.selfStake = own
    validator.inactiveStake = inactiveStake
    validator.allNominators = allNominators
    validator.activeNominators = activeNominators

    await validator.save()
}

// Create a Nomination record
const createNomination = async(extrinsicHash, nominatorStash, blockNumber) => {
    let nomination = new Nomination(extrinsicHash)
    // @ts-ignore
    nomination.nominatorId = nominatorStash.toString();
    nomination.blockNumber = blockNumber;
    await nomination.save()
}

// Create a `ValidatorNomination` Record
const createValidatorNomination = async(id, blockNumber, nominatorStash, validatorStash, extrinsicHash, bond) => {
    let validatorNomination = await ValidatorNomination.get(id)
    if (!validatorNomination) {
        validatorNomination = new ValidatorNomination(id);
        validatorNomination.blockNumber = blockNumber
        //@ts-ignore
        validatorNomination.nominatorId = nominatorStash
        //@ts-ignore
        validatorNomination.validatorId = validatorStash
        //@ts-ignore
        validatorNomination.nominationId = extrinsicHash
        validatorNomination.bond = bond
        await validatorNomination.save()
    }
}

// Ensure that a `Validator` record exists, if it doesn't, create it
const ensureValidator = async(stash: string): Promise<void> =>{
    const validator = await Validator.get(stash)
    if (!validator){
        await new Validator(stash).save();
    }
}

// Ensure that a `Nominator` record exists, if it doesn't, create it
const ensureNominator = async(stash: string): Promise<void> => {
    const nominator = await Nominator.get(stash)
    if (!nominator){
        await new Nominator(stash).save();
    }
}

const isValidAddressPolkadotAddress = (address) => {
    try {
        encodeAddress(
            isHex(address)
                ? hexToU8a(address)
                : decodeAddress(address)
        );

        return true;
    } catch (error) {
        return false;
    }
};
